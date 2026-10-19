"""Offline adapter for the measured 20-column Trip.com Booking XLSX v0.1.

Writes only the rows_json array. Dates remain source text: Date (GMT+8) is
GMT+8 local time, not UTC; no timezone conversion or date invention occurs.
Numeric Excel dates and unmeasured layouts fail closed. AID is supplied later
by the operator, never inferred here. For later multipart acceptance, upload
the SAME untouched original XLSX bytes alongside rows_json. This CLI does not
upload. A reconstructed workbook's hash identifies only that reconstruction.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

COLUMNS = (
    ("Site Name", "sidName"),
    ("Booking ID", "orderId"),
    ("Date (GMT+8)", "orderDate"),
    ("Product Type", "productLine"),
    ("Amount", "amount"),
    ("Currency", "currency"),
    ("Booking Status", "orderStatus"),
    ("Site ID", "sid"),
    ("Departure/Check-in Date", "productStartDate"),
    ("Arrival/Check-out Date", "productEndDate"),
    ("Booking Window", "bookingWindow"),
    ("OUID", "ouid"),
    ("Departure City", "departureCity"),
    ("Departure Country", "departureCountry"),
    ("Arrival City", "arrivalCity"),
    ("Arrival Country", "arrivalCountry"),
    ("Booking Platform", "orderPlatform"),
    ("Region of Booking User", "region"),
    ("tripSub1", "tripSub1"),
    ("tripSub3", "tripSub3"),
)
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
P = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MAX_SAFE_INTEGER = 9007199254740991


class AdapterError(ValueError):
    """Messages contain structure/field names only, never source row values."""


def _xml(archive, name, root_tag):
    data = archive.read(name)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise AdapterError("Unsupported XML declarations")
    element = ET.fromstring(data)
    if element.tag != root_tag:
        raise AdapterError("Invalid XLSX XML root")
    return element


def _text(element):
    # Text runs only; phonetic annotations are not part of the source string.
    return "".join(t.text or "" for t in element.findall(S + "t")) + "".join(
        t.text or "" for t in element.findall(S + "r/" + S + "t")
    )


def _cell(cell, shared):
    if cell.find(S + "f") is not None:
        raise AdapterError("Formula cells are unsupported")
    kind = cell.get("t", "n")
    value = cell.find(S + "v")
    if kind == "inlineStr":
        inline = cell.find(S + "is")
        if inline is None:
            raise AdapterError("Invalid inline string")
        return _text(inline), "text"
    if kind == "s":
        if value is None or not re.fullmatch(r"[0-9]+", value.text or ""):
            raise AdapterError("Invalid shared string reference")
        index = int(value.text)
        if index >= len(shared):
            raise AdapterError("Invalid shared string reference")
        return shared[index], "text"
    if kind not in ("n", "str"):
        raise AdapterError("Unsupported cell type")
    return (value.text if value is not None else None), (
        "number" if kind == "n" else "text"
    )


def _integer(value, field):
    # Never pass through float. Excel numeric identifiers exceeding 15 digits
    # may already have lost precision; require a text cell for those IDs.
    if not re.fullmatch(r"[0-9]+(?:\.0+)?", value):
        raise AdapterError("Invalid numeric integer: " + field)
    digits = value.split(".", 1)[0].lstrip("0") or "0"
    if len(digits) > 15:
        raise AdapterError("Unsafe numeric precision: " + field)
    return digits


def _money(value, kind):
    if value is None or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?", value):
        raise AdapterError("Invalid nonnegative booking amount")
    whole, _, fraction = value.partition(".")
    if kind == "number" and len((whole + fraction).lstrip("0")) > 15:
        raise AdapterError("Unsafe numeric precision: amount")
    micros = int(whole) * 1000000 + int(fraction.ljust(6, "0") or "0")
    if micros > MAX_SAFE_INTEGER:
        raise AdapterError("Unsafe money micros precision")
    return value


def _table(archive):
    if len(archive.namelist()) != len(set(archive.namelist())):
        raise AdapterError("Duplicate XLSX parts")
    _xml(archive, "[Content_Types].xml",
         "{http://schemas.openxmlformats.org/package/2006/content-types}Types")
    workbook = _xml(archive, "xl/workbook.xml", S + "workbook")
    sheets = workbook.findall(S + "sheets/" + S + "sheet")
    if len(sheets) != 1:
        raise AdapterError("Exactly one worksheet is supported")
    relations = _xml(archive, "xl/_rels/workbook.xml.rels", P + "Relationships")
    matches = [r for r in relations if r.get("Id") == sheets[0].get(R + "id")]
    if len(matches) != 1 or matches[0].get("TargetMode", "Internal") != "Internal":
        raise AdapterError("Invalid worksheet relationship")
    relation = matches[0]
    if relation.get("Type") != R[1:-1] + "/worksheet":
        raise AdapterError("Unsupported worksheet relationship")
    target = relation.get("Target", "")
    if not target or "\\" in target:
        raise AdapterError("Invalid worksheet target")
    name = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                             else posixpath.join("xl", target))
    if not name.startswith("xl/worksheets/") or not name.endswith(".xml"):
        raise AdapterError("Invalid worksheet target")
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = [_text(si) for si in _xml(archive, "xl/sharedStrings.xml", S + "sst")]
    sheet = _xml(archive, name, S + "worksheet")
    if sheet.find(S + "mergeCells") is not None:
        raise AdapterError("Merged cells are unsupported")
    rows = []
    previous = 0
    for row in sheet.findall(S + "sheetData/" + S + "row"):
        number = row.get("r", "")
        if not re.fullmatch(r"[1-9][0-9]*", number) or int(number) <= previous:
            raise AdapterError("Invalid worksheet row numbering")
        previous = int(number)
        cells = {}
        for cell in row.findall(S + "c"):
            reference = re.fullmatch(r"([A-T])([1-9][0-9]*)", cell.get("r", ""))
            if reference is None or reference[2] != number:
                raise AdapterError("Cell outside measured 20-column contract")
            column = ord(reference[1]) - ord("A")
            if column in cells:
                raise AdapterError("Duplicate worksheet cell")
            cells[column] = _cell(cell, shared)
        if any(v not in (None, "") for v, _ in cells.values()):
            rows.append(cells)
    return rows


def read_booking_xlsx(input_path):
    """Return (rows_json array, SHA-256 of the exact input bytes)."""
    data = Path(input_path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            table = _table(archive)
    except (KeyError, zipfile.BadZipFile, ET.ParseError, RuntimeError) as error:
        raise AdapterError("Invalid XLSX package") from error
    if not table:
        raise AdapterError("Missing measured headers")
    headers = [table[0].get(i, (None, "text"))[0] for i in range(20)]
    if headers != [header for header, _ in COLUMNS]:
        raise AdapterError("Missing, duplicate, reordered or unsupported headers")
    result, seen = [], set()
    for cells in table[1:]:
        row = {}
        for index, (_, field) in enumerate(COLUMNS):
            value, kind = cells.get(index, (None, "text"))
            if value is None or value.strip() == "":
                value = None
            if field == "amount":
                value = _money(value, kind)
            elif kind == "number" and value is not None:
                if field not in ("sid", "orderId", "bookingWindow"):
                    raise AdapterError("Unsupported numeric cell: " + field)
                value = _integer(value, field)
                if field == "bookingWindow":
                    value = int(value)
            row[field] = value
        for field in ("orderId", "sid", "productLine"):
            if not isinstance(row[field], str) or not row[field].strip():
                raise AdapterError("Missing booking identity: " + field)
        identity = (row["sid"], row["orderId"], row["productLine"])
        if identity in seen:
            raise AdapterError("Duplicate booking identity")
        seen.add(identity)
        result.append(row)
    if not result:
        raise AdapterError("No booking data rows")
    return result, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source, output = Path(args.input), Path(args.output)
    try:
        if source.resolve() == output.resolve() or (output.exists() and source.samefile(output)):
            raise AdapterError("Output must differ from the source XLSX")
        rows, digest = read_booking_xlsx(source)
        output.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except AdapterError as error:
        parser.exit(2, "Booking XLSX rejected: " + str(error) + "\n")
    except OSError:
        parser.exit(2, "Booking XLSX file read/write failed\n")
    print(json.dumps({"rows_seen": len(rows), "source_file_sha256": digest}))


if __name__ == "__main__":
    main()
