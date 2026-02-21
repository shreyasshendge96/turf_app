const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V6-DEBUG-TYPO-FIX";

/**
 * Handles GET requests: Availability & Version Check.
 */
function doGet(e) {
  try {
    // Version check
    if (e.parameter.check === "version") {
      return createJsonResponse({
        status: "success",
        version: SCRIPT_VERSION,
        time: new Date().toLocaleTimeString(),
        note: "Ensure access is set to ANYONE"
      });
    }

    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

    const scriptProps = PropertiesService.getScriptProperties();
    const cacheKey = "booked_" + date;
    let currentBookedSlotsStr = scriptProps.getProperty(cacheKey);

    // If not in cache (first time or daily refresh), scan sheet
    if (currentBookedSlotsStr === null) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
      const bookedArray = scanSheetForBookedSlots(date, sheet);
      currentBookedSlotsStr = bookedArray.join(",");
      scriptProps.setProperty(cacheKey, currentBookedSlotsStr);
    }

    const bookedSlotsNormalized = currentBookedSlotsStr ? currentBookedSlotsStr.split(",") : [];
    return createJsonResponse({ status: "success", bookedSlots: bookedSlotsNormalized });

  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Handles POST requests: Double-Booking Prevention.
 */
function doPost(e) {
  try {
    const scriptProps = PropertiesService.getScriptProperties();
    const formData = JSON.parse(e.postData.contents || "{}");

    const date = formData.Select_Date;
    const requestedSlotsStr = formData["Select Time Slots (500 per hr)"] || "";
    const requestedSlotsArray = requestedSlotsStr.split(",").map(s => s.trim()).filter(s => s);

    if (requestedSlotsArray.length === 0) throw new Error("No slots selected");

    // Fast Double-Booking Check (Server-Side)
    const cacheKey = "booked_" + date;
    const currentCachedStr = scriptProps.getProperty(cacheKey) || "";
    const alreadyBookedArray = currentCachedStr.split(",").filter(s => s);

    // Check for overlap
    const conflicts = requestedSlotsArray.filter(s => alreadyBookedArray.includes(s));

    if (conflicts.length > 0) {
      return createJsonResponse({
        status: "error",
        message: "STILL ABLE TO BOOK? NO! These slots were literally JUST taken by someone else: " + conflicts.join(", ")
      });
    }

    // Prepare Sheet Mapping
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headerMap = {};
    headers.forEach((h, i) => headerMap[h.toString().trim().toLowerCase()] = i);

    const rowToAppend = new Array(headers.length).fill("");

    Object.keys(formData).forEach(key => {
      const normKey = key.trim().toLowerCase();
      if (headerMap.hasOwnProperty(normKey)) {
        rowToAppend[headerMap[normKey]] = formData[key];
      } else {
        // Fuzzy map for User/Email/Mobile
        for (let h in headerMap) {
          if (h.includes(normKey) || normKey.includes(h)) {
            rowToAppend[headerMap[h]] = formData[key];
            break;
          }
        }
      }
    });

    if (headerMap.hasOwnProperty("timestamp")) rowToAppend[headerMap["timestamp"]] = new Date().toLocaleString();

    // Write to Sheet
    sheet.appendRow(rowToAppend);

    // Update Counter (Global State)
    const newBookedStr = [...alreadyBookedArray, ...requestedSlotsArray].join(",");
    scriptProps.setProperty(cacheKey, newBookedStr);

    return createJsonResponse({ status: "success", message: "Slot Confirmed and Synced!" });

  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Triggered daily to clear cache
 */
function dailyRefresh() {
  const scriptProps = PropertiesService.getScriptProperties();
  scriptProps.deleteAllProperties(); // Fresh start every day
  Logger.log("Daily Refresh: Cleared all slot reservations.");
}

function scanSheetForBookedSlots(date, sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(h => h.toString().trim().toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const slotIdx = headers.findIndex(h => h.includes("slot"));

  if (dateIdx === -1 || slotIdx === -1) return [];

  const bookedSlotsSet = new Set();
  for (let i = 1; i < data.length; i++) {
    let rowDate = data[i][dateIdx];
    let rowDateStr = (rowDate instanceof Date) ? Utilities.formatDate(rowDate, Session.getScriptTimeZone(), "yyyy-MM-dd") : rowDate.toString().trim();
    if (rowDateStr === date) {
      data[i][slotIdx].toString().split(",").map(s => s.trim()).forEach(s => { if (s) bookedSlotsSet.add(s); });
    }
  }
  return Array.from(bookedSlotsSet);
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function setupDailyRefreshTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => { if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(0).everyDays(1).create();
}
