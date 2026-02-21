const DATA_ENTRY_SHEET_NAME = "Sheet1";
const TIME_STAMP_COLUMN_NAME = "Timestamp";

/**
 * Handles GET requests. Uses ScriptProperties for ultra-fast response.
 */
function doGet(e) {
  try {
    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

    // Use fast cache (Script Properties) instead of scanning the whole sheet for the UI
    const scriptProps = PropertiesService.getScriptProperties();
    const cacheKey = "booked_" + date;
    const cachedSlotsStr = scriptProps.getProperty(cacheKey) || "";

    // If cache is empty, try to populate it once by scanning the sheet
    if (!cachedSlotsStr) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
      if (sheet) {
        const booked = scanSheetForBookedSlots(date, sheet);
        scriptProps.setProperty(cacheKey, booked.join(","));
        return createJsonResponse({ status: "success", bookedSlots: booked });
      }
    }

    const bookedSlots = cachedSlotsStr.split(",").filter(s => s);
    return createJsonResponse({ status: "success", bookedSlots: bookedSlots });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Handles POST requests with "Double-Booking Prevention" in the fast cache.
 */
function doPost(e) {
  try {
    const scriptProps = PropertiesService.getScriptProperties();
    const formData = JSON.parse(e.postData.contents || "{}");

    const date = formData.Select_Date;
    const slotsString = formData["Select Time Slots (500 per hr)"] || "";
    const requestedSlots = slotsString.split(",").map(s => s.trim()).filter(s => s);

    if (requestedSlots.length === 0) throw new Error("No slots selected");

    // 1. FAST CHECK (Double Booking)
    const cacheKey = "booked_" + date;
    const cachedSlotsStr = scriptProps.getProperty(cacheKey) || "";
    const existingSlots = cachedSlotsStr.split(",").filter(s => s);
    const conflicts = requestedSlots.filter(s => existingSlots.includes(s));

    if (conflicts.length > 0) {
      return createJsonResponse({
        status: "error",
        message: "STILL ABLE TO BOOK? No! These slots were just taken: " + conflicts.join(", ")
      });
    }

    // 2. SHEET WRITE
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headerMap = {};
    headers.forEach((h, i) => headerMap[h.toString().trim().toLowerCase()] = i);

    const row = new Array(headers.length).fill("");
    Object.keys(formData).forEach(key => {
      const normalizedKey = key.trim().toLowerCase();
      if (headerMap.hasOwnProperty(normalizedKey)) {
        row[headerMap[normalizedKey]] = formData[key];
      } else {
        // Fuzzy logic for User/Name
        for (let h in headerMap) {
          if (h.includes(normalizedKey) || normalizedKey.includes(h)) {
            row[headerMap[h]] = formData[key];
            break;
          }
        }
      }
    });

    if (headerMap.hasOwnProperty("timestamp")) row[headerMap["timestamp"]] = new Date().toLocaleString();
    sheet.appendRow(row);

    // 3. FAST UPDATE (Add to cache)
    const updatedSlots = [...existingSlots, ...requestedSlots];
    scriptProps.setProperty(cacheKey, updatedSlots.join(","));

    return createJsonResponse({ status: "success", message: "Booking confirmed and synced!" });
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Refresh trigger: Clears old data daily
 */
function dailyRefresh() {
  const scriptProps = PropertiesService.getScriptProperties();
  const now = new Date();
  const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  const yesterdayStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), "yyyy-MM-dd");

  // Clear yesterday's cache key to keep properties clean
  scriptProps.deleteProperty("booked_" + yesterdayStr);
  Logger.log("Refreshed cache for " + yesterdayStr);
}

function scanSheetForBookedSlots(date, sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(h => h.toString().trim().toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const slotIdx = headers.findIndex(h => h.includes("slot"));

  if (dateIdx === -1 || slotIdx === -1) return [];

  const bookedSlotsSet = new Set();
  for (let i = 1; i < data.length; i++) {
    let rowDateStr = "";
    if (data[i][dateIdx] instanceof Date) {
      rowDateStr = Utilities.formatDate(data[i][dateIdx], Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else {
      rowDateStr = data[i][dateIdx].toString().trim();
    }

    if (rowDateStr === date) {
      data[i][slotIdx].toString().split(",").map(s => s.trim()).forEach(s => {
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
 * Run this function once manually in the editor to setup the daily refresh trigger.
 */
function setupDailyRefreshTrigger() {
  // Delete existing triggers for this function to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });

  // Create a new trigger for every midnight
  ScriptApp.newTrigger('dailyRefresh')
    .timeBased()
    .atHour(0)
    .everyDays(1)
    .create();

  Logger.log("Daily refresh trigger set successfully!");
}
