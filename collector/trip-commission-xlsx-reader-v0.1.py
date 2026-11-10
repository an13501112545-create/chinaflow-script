"""Offline reader for the observed Trip.com commission workbook, not general XLSX.

Reads bytes on stdin, returns a string table on stdout. Never evaluates formulas,
extracts files, resolves external resources, or includes source values in errors.
"""
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
LIMIT = 8 * 1024 * 1024


def read_table(data):
    if not data or len(data) > 4 * 1024 * 1024:
        raise ValueError()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (len(entries) > 32 or len(set(names)) != len(names)
                or sum(entry.file_size for entry in entries) > LIMIT
                or any(entry.flag_bits & 1 for entry in entries)):
            raise ValueError()

        def xml(name):
            content = archive.read(name)
            # ElementTree does not fetch external entities; reject declarations
            # as well, including alternate encodings, before parsing.
            text = content.decode("utf-8")
            if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
                raise ValueError()
            return ET.fromstring(text)

        workbook = xml("xl/workbook.xml")
        sheets = workbook.findall(f"{MAIN}sheets/{MAIN}sheet")
        if len(sheets) != 1 or sheets[0].get("name") != "Trip.com_Commission_Report":
            raise ValueError()
        links = xml("xl/_rels/workbook.xml.rels")
        targets = [link for link in links.findall(f"{REL}Relationship")
                   if link.get("Id") == sheets[0].get(RID)]
        if (len(targets) != 1 or targets[0].get("TargetMode") is not None
                or targets[0].get("Target") != "worksheets/sheet1.xml"
                or not targets[0].get("Type", "").endswith("/worksheet")):
            raise ValueError()
        sheet = xml("xl/worksheets/sheet1.xml")
        if sheet.find(f"{MAIN}mergeCells") is not None:
            raise ValueError()
        tables = sheet.findall(f"{MAIN}sheetData")
        if len(tables) != 1:
            raise ValueError()
        table = []
        for index, row in enumerate(tables[0], 1):
            if row.tag != f"{MAIN}row" or row.get("r") != str(index):
                raise ValueError()
            values = [""] * 19
            seen = set()
            for cell in row:
                address = cell.get("r", "")
                match = re.fullmatch(r"([A-S])" + str(index), address)
                if (cell.tag != f"{MAIN}c" or not match or address in seen
                        or cell.get("t") not in (None, "n", "str")
                        or len(cell) != 1 or cell[0].tag != f"{MAIN}v"):
                    raise ValueError()
                seen.add(address)
                # Preserve numeric XML text, especially long IDs, without float conversion.
                values[ord(match[1]) - ord("A")] = cell[0].text or ""
            if index == 1 and len(seen) != 19:
                raise ValueError()
            table.append(values)
        return table


if __name__ == "__main__":
    try:
        result = read_table(sys.stdin.buffer.read(4 * 1024 * 1024 + 1))
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
    except Exception:
        sys.stderr.write("Unsupported or invalid Trip commission XLSX\n")
        sys.exit(1)
