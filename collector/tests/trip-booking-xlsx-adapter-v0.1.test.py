"""Sanitized synthetic fixtures only; all XLSX files are built in temp directories."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

ADAPTER_PATH = Path(__file__).resolve().parents[1] / "trip-booking-xlsx-adapter-v0.1.py"
spec = importlib.util.spec_from_file_location("booking_adapter", ADAPTER_PATH)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
HEADERS = [header for header, _ in adapter.COLUMNS]
# Deliberately unrelated identities, OUID, tracking, cities and source amounts.
VALUES = ["Synthetic Site", "0009876543210987654", "2026-10-01 18:04",
          "Hotels", "42.75", "USD", "Pending", ("n", "123456789"),
          "2026-10-03 23:00", "2026-10-05 00:00", ("n", "2"),
          "SYNTHETIC-OUID", "Test City", "Test Country", "Test City",
          "Test Country", "online", "zz", "synthetic-p", None]
S = adapter.S


def write_fixture(path, rows=None, headers=None, shared=False, formula=False, sheets=1):
    table = [HEADERS if headers is None else headers] + ([VALUES] if rows is None else rows)
    worksheet = ET.Element(S + "worksheet")
    data = ET.SubElement(worksheet, S + "sheetData")
    strings = []
    for number, values in enumerate(table, 1):
        row = ET.SubElement(data, S + "row", r=str(number))
        for index, value in enumerate(values):
            if value is None:
                continue
            cell = ET.SubElement(row, S + "c", r=chr(65 + index) + str(number))
            if isinstance(value, tuple):
                cell.set("t", value[0])
                ET.SubElement(cell, S + "v").text = value[1]
            elif shared:
                cell.set("t", "s")
                ET.SubElement(cell, S + "v").text = str(len(strings))
                strings.append(value)
            else:
                cell.set("t", "inlineStr")
                ET.SubElement(ET.SubElement(cell, S + "is"), S + "t").text = value
            if formula and number == 2 and index == 4:
                ET.SubElement(cell, S + "f").text = "1+1"
    workbook = ET.Element(S + "workbook")
    sheet_list = ET.SubElement(workbook, S + "sheets")
    for index in range(sheets):
        ET.SubElement(sheet_list, S + "sheet", name="Synthetic" + str(index),
                      sheetId=str(index + 1), attrib={adapter.R + "id": "rId" + str(index + 1)})
    relationships = ET.Element(adapter.P + "Relationships")
    for index in range(sheets):
        ET.SubElement(relationships, adapter.P + "Relationship", Id="rId" + str(index + 1),
                      Type=adapter.R[1:-1] + "/worksheet", Target="worksheets/sheet1.xml")
    root_rels = ET.Element(adapter.P + "Relationships")
    ET.SubElement(root_rels, adapter.P + "Relationship", Id="rId1",
                  Type=adapter.R[1:-1] + "/officeDocument", Target="xl/workbook.xml")
    ct = "{http://schemas.openxmlformats.org/package/2006/content-types}"
    types = ET.Element(ct + "Types")
    ET.SubElement(types, ct + "Default", Extension="rels",
                  ContentType="application/vnd.openxmlformats-package.relationships+xml")
    ET.SubElement(types, ct + "Default", Extension="xml", ContentType="application/xml")
    for part, content in [("/xl/workbook.xml", "sheet.main"),
                          ("/xl/worksheets/sheet1.xml", "worksheet"),
                          ("/xl/sharedStrings.xml", "sharedStrings")]:
        ET.SubElement(types, ct + "Override", PartName=part,
                      ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml." + content + "+xml")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, element in [("[Content_Types].xml", types), ("_rels/.rels", root_rels),
                              ("xl/workbook.xml", workbook), ("xl/_rels/workbook.xml.rels", relationships),
                              ("xl/worksheets/sheet1.xml", worksheet)]:
            archive.writestr(name, ET.tostring(element, encoding="utf-8", xml_declaration=True))
        if shared:
            sst = ET.Element(S + "sst")
            for text in strings:
                ET.SubElement(ET.SubElement(sst, S + "si"), S + "t").text = text
            archive.writestr("xl/sharedStrings.xml", ET.tostring(sst))


class BookingAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="chinaflow-booking-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / "synthetic.xlsx"
        self.output = Path(self.temp.name) / "rows.json"

    def parse(self, **options):
        write_fixture(self.input, **options)
        return adapter.read_booking_xlsx(self.input)

    def reject_value(self, index, values):
        for value in values:
            with self.subTest(column=HEADERS[index], value=value):
                row = list(VALUES)
                row[index] = value
                with self.assertRaises(adapter.AdapterError):
                    self.parse(rows=[row])

    def test_exact_twenty_column_contract_and_raw_fields(self):
        rows, _ = self.parse()
        expected = {field: value for (_, field), value in zip(adapter.COLUMNS, VALUES)}
        expected.update(sid="123456789", bookingWindow=2)
        self.assertEqual(rows, [expected])
        self.assertNotIn("aid", rows[0])
        self.assertNotIn("commissionAmount", rows[0])
        self.assertEqual(len(rows[0]), 20)

    def test_shared_and_inline_strings_agree(self):
        inline, _ = self.parse()
        shared, _ = self.parse(shared=True)
        self.assertEqual(shared, inline)

    def test_numeric_ids_are_exact_strings(self):
        row = list(VALUES)
        row[1] = ("n", "987654321012345")
        row[7] = ("n", "123456789.0")
        rows, _ = self.parse(rows=[row])
        self.assertEqual(rows[0]["orderId"], "987654321012345")
        self.assertEqual(rows[0]["sid"], "123456789")

    def test_unsafe_or_noninteger_numeric_ids_rejected(self):
        for index in (1, 7):
            self.reject_value(index, [("n", "9876543210123456"), ("n", "123.5"),
                                      ("n", "1.234E8"), ("n", "NaN")])

    def test_missing_and_blank_identities_rejected(self):
        for index in (1, 3, 7):
            self.reject_value(index, [None, "", "   "])

    def test_missing_header_rejected(self):
        with self.assertRaises(adapter.AdapterError):
            self.parse(headers=HEADERS[:-1])

    def test_duplicate_header_rejected(self):
        headers = list(HEADERS)
        headers[7] = "Booking ID"
        with self.assertRaises(adapter.AdapterError):
            self.parse(headers=headers)

    def test_reordered_and_extra_headers_rejected(self):
        for headers in ([HEADERS[1], HEADERS[0]] + HEADERS[2:], HEADERS + ["AID"]):
            with self.assertRaises(adapter.AdapterError):
                self.parse(headers=headers)

    def test_unknown_product_status_and_tracking_preserved(self):
        row = list(VALUES)
        row[3], row[6], row[18] = "Future Product", "Future Status", "unmatched-synthetic"
        rows, _ = self.parse(rows=[row])
        self.assertEqual(rows[0]["productLine"], row[3])
        self.assertEqual(rows[0]["orderStatus"], row[6])
        self.assertEqual(rows[0]["tripSub1"], row[18])
        self.assertNotIn("publisher_id", rows[0])

    def test_blank_tracking_remains_null(self):
        row = list(VALUES)
        row[18], row[19] = None, "   "
        rows, _ = self.parse(rows=[row])
        self.assertIsNone(rows[0]["tripSub1"])
        self.assertIsNone(rows[0]["tripSub3"])

    def test_negative_and_malformed_amount_rejected(self):
        self.reject_value(4, ["-1.25", "-0.00", "1,000.00", "1e2", "NaN", None,
                              " 42.75", "42.7500001", "9007199254.740992"])

    def test_numeric_amount_is_exact_source_decimal(self):
        row = list(VALUES)
        row[4] = ("n", "42.750000")
        rows, _ = self.parse(rows=[row])
        self.assertEqual(rows[0]["amount"], "42.750000")
        self.reject_value(4, [("n", "0.1234567"), ("n", "1E2")])

    def test_dates_preserve_gmt8_text_and_numeric_dates_fail_closed(self):
        rows, _ = self.parse()
        self.assertEqual(rows[0]["orderDate"], VALUES[2])
        self.assertEqual(rows[0]["productStartDate"], VALUES[8])
        self.assertEqual(rows[0]["productEndDate"], VALUES[9])
        for index in (2, 8, 9):
            self.reject_value(index, [("n", "46000.5")])

    def test_duplicate_identity_rejected_and_unique_rows_allowed(self):
        with self.assertRaises(adapter.AdapterError):
            self.parse(rows=[VALUES, VALUES])
        other = list(VALUES)
        other[1] = "SYNTHETIC-SECOND-ORDER"
        rows, _ = self.parse(rows=[VALUES, other])
        self.assertEqual(len(rows), 2)

    def test_invalid_xlsx_rejected(self):
        for data in (b"not an xlsx", b"PK\x03\x04broken"):
            self.input.write_bytes(data)
            with self.assertRaises(adapter.AdapterError):
                adapter.read_booking_xlsx(self.input)
        with zipfile.ZipFile(self.input, "w") as archive:
            archive.writestr("xl/workbook.xml", "<broken")
        with self.assertRaises(adapter.AdapterError):
            adapter.read_booking_xlsx(self.input)

    def test_formulas_multiple_sheets_and_empty_reports_rejected(self):
        for options in ({"formula": True}, {"sheets": 2}, {"rows": []}):
            with self.assertRaises(adapter.AdapterError):
                self.parse(**options)

    def test_input_bytes_hash_and_repeat_are_unchanged(self):
        first = self.parse(shared=True)
        before = self.input.read_bytes()
        second = adapter.read_booking_xlsx(self.input)
        self.assertEqual(first, second)
        self.assertEqual(first[1], hashlib.sha256(before).hexdigest())
        self.assertEqual(self.input.read_bytes(), before)

    def test_cli_emits_rows_file_and_safe_report(self):
        write_fixture(self.input, shared=True)
        before = self.input.read_bytes()
        command = [sys.executable, "-B", str(ADAPTER_PATH), "--input", str(self.input),
                   "--output", str(self.output)]
        first = subprocess.run(command, capture_output=True, text=True, check=True)
        output = self.output.read_bytes()
        second = subprocess.run(command, capture_output=True, text=True, check=True)
        report = json.loads(first.stdout)
        self.assertEqual(report, {"rows_seen": 1, "source_file_sha256": hashlib.sha256(before).hexdigest()})
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(self.output.read_bytes(), output)
        self.assertEqual(self.input.read_bytes(), before)
        self.assertEqual(json.loads(output), adapter.read_booking_xlsx(self.input)[0])
        for private_value in (VALUES[1], VALUES[11], VALUES[0]):
            self.assertNotIn(private_value, first.stdout + first.stderr)

    def test_cli_rejection_is_safe_and_does_not_write(self):
        row = list(VALUES)
        row[4] = "PRIVATE-INVALID-AMOUNT"
        write_fixture(self.input, rows=[row])
        result = subprocess.run([sys.executable, "-B", str(ADAPTER_PATH), "--input", str(self.input),
                                 "--output", str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(row[4], result.stdout + result.stderr)
        self.assertNotIn(VALUES[11], result.stdout + result.stderr)
        self.assertFalse(self.output.exists())

    def test_cli_cannot_overwrite_source(self):
        write_fixture(self.input)
        before = self.input.read_bytes()
        result = subprocess.run([sys.executable, "-B", str(ADAPTER_PATH), "--input", str(self.input),
                                 "--output", str(self.input)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.input.read_bytes(), before)


if __name__ == "__main__":
    # Node integration tests use this synthetic builder; never the private sample.
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        write_fixture(Path(sys.argv[2]), shared=True)
    else:
        unittest.main()
