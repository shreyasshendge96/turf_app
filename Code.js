const DATA_ENTRY_SHEET_NAME = "Sheet1";
const TIME_STAMP_COLUMN_NAME = "Timestamp";

/**
 * Handles GET requests to fetch already booked slots for a given date.
 */
function doGet(e) {
  try {
    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    if (!sheet) return createJsonResponse({ status: "error", message: "Sheet not found" });

    const bookedSlots = getBookedSlotsForDate(date, sheet);
    return createJsonResponse({ status: "success", bookedSlots: bookedSlots });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Handles POST requests for new bookings with double-booking prevention.
 */
function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    if (!sheet) throw new Error(`Sheet '${DATA_ENTRY_SHEET_NAME}' not found`);

    const formData = JSON.parse(e.postData.contents || "{}");

    // 1. Validate Double Booking
    const date = formData.Select_Date;
    const slotsString = formData["Select Time Slots (500 per hr)"] || "";
    const requestedSlots = slotsString.split(",").map(s => s.trim()).filter(s => s);

    if (requestedSlots.length === 0) throw new Error("No slots selected");

    const existingSlots = getBookedSlotsForDate(date, sheet);
    const conflicts = requestedSlots.filter(s => existingSlots.includes(s));

    if (conflicts.length > 0) {
      return createJsonResponse({
        status: "error",
        message: "Double booking detected! These slots are already taken: " + conflicts.join(", ")
      });
    }

    // 2. Prepare Data Mapping
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headerMap = {};
    headers.forEach((header, index) => {
      headerMap[header.toString().trim().toLowerCase()] = index;
    });

    const row = new Array(headers.length).fill("");

    // 3. Robust Fuzzy Mapping
    Object.keys(formData).forEach(key => {
      const normalizedKey = key.trim().toLowerCase();

      // Exact match first
      if (headerMap.hasOwnProperty(normalizedKey)) {
        row[headerMap[normalizedKey]] = formData[key];
      } else {
        // Fallback fuzzy search (e.g. "mobile" matches "mobile_number")
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
      row[headerMap["timestamp"]] = new Date().toLocaleString();
    }

    // 4. Final Submission
    sheet.appendRow(row);

    return createJsonResponse({ status: "success", message: "Booking confirmed!" });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Finds all booked slots for a specific date in the sheet.
 */
function getBookedSlotsForDate(date, sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(h => h.toString().trim().toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const slotIdx = headers.findIndex(h => h.includes("slot"));

  if (dateIdx === -1 || slotIdx === -1) return [];

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
  return Array.from(bookedSlotsSet);
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Troubleshooting function: Check sheet connection
 */
function testConnection() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  if (!sheet) {
    Logger.log("ERROR: Sheet '" + DATA_ENTRY_SHEET_NAME + "' not found!");
  } else {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Logger.log("SUCCESS: Linked to sheet.");
    Logger.log("Columns found: " + headers.join(" | "));

    // Log normalized keys the script expects
    Logger.log("Mapped Keys: " + headers.map(h => h.toString().trim().toLowerCase()).join(", "));
  }
}
