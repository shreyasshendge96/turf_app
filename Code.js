const DATA_ENTRY_SHEET_NAME = "Sheet1";
const TIME_STAMP_COLUMN_NAME = "Timestamp";
const FOLDER_ID = "11_1y25b-VrUr1qNGY1_dELhyT1Ixuyk6";

function doGet(e) {
  try {
    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    if (!sheet) return createJsonResponse({ status: "error", message: "Sheet not found" });

    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => h.toString().trim().toLowerCase());

    // Find column indexes using fuzzy search (case-insensitive, trimmed)
    const dateIdx = headers.findIndex(h => h.includes("date"));
    const slotIdx = headers.findIndex(h => h.includes("slot"));

    if (dateIdx === -1 || slotIdx === -1) {
      return createJsonResponse({ status: "success", bookedSlots: [] });
    }

    const bookedSlotsSet = new Set();
    for (let i = 1; i < data.length; i++) {
      let rowDate = data[i][dateIdx];
      let rowDateStr = "";
      if (rowDate instanceof Date) {
        rowDateStr = Utilities.formatDate(rowDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        rowDateStr = rowDate.toString().trim();
      }

      if (rowDateStr === date) {
        const slotsRaw = data[i][slotIdx].toString();
        slotsRaw.split(",").map(s => s.trim()).forEach(s => {
          if (s) bookedSlotsSet.add(s);
        });
      }
    }

    return createJsonResponse({ status: "success", bookedSlots: Array.from(bookedSlotsSet) });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    if (!sheet) throw new Error(`Sheet '${DATA_ENTRY_SHEET_NAME}' not found`);

    const formData = JSON.parse(e.postData.contents || "{}");
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Create a robust mapping: key -> column index
    const headerMap = {};
    headers.forEach((header, index) => {
      const normalizedHeader = header.toString().trim().toLowerCase();
      headerMap[normalizedHeader] = index;
    });

    const row = new Array(headers.length).fill("");

    // Fill the row using normalized keys
    Object.keys(formData).forEach(key => {
      const normalizedKey = key.trim().toLowerCase();
      if (headerMap.hasOwnProperty(normalizedKey)) {
        row[headerMap[normalizedKey]] = formData[key];
      } else {
        // Fallback for fields like "Mobile_No" matching "Mobile_Number"
        for (let header in headerMap) {
          if (header.includes(normalizedKey) || normalizedKey.includes(header)) {
            row[headerMap[header]] = formData[key];
            break;
          }
        }
      }
    });

    // Add Timestamp if column exists
    if (headerMap.hasOwnProperty("timestamp")) {
      row[headerMap["timestamp"]] = new Date().toISOString();
    } else if (headers.length > 0) {
      // If no timestamp column, just append it if you want, but better to stick to headers
    }

    sheet.appendRow(row);

    return createJsonResponse({ status: "success", message: "Data submitted!" });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this function once from the editor to test if the script can see your sheet
 */
function testConnection() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  if (!sheet) {
    Logger.log("ERROR: Sheet not found!");
  } else {
    Logger.log("SUCCESS: Found sheet with " + sheet.getLastColumn() + " columns.");
    Logger.log("Headers: " + sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  }
}
