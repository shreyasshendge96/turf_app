const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V22-REALTIME";
const FOLDER_ID = "11_1y25b-VrUr1qNGY1_dELhyT1Ixuyk6";

// RAZORPAY CREDENTIALS (TEST MODE)
const RZP_KEY_ID = "rzp_test_SJ6lquRPN8TtH1";
const RZP_KEY_SECRET = "82ozyK7jcQBAB2NMPIyErDJU";

/**
 * Handles GET requests: Availability, Version, & Pricing Check.
 */
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = (params.action || "").toString().trim().toLowerCase();

    // DEBUG: Log the incoming request to Apps Script Execution Logs
    Logger.log(`[GET] Action: ${action}, Params: ${JSON.stringify(params)}`);

    // 1. Version Check
    if (params.check === "version") {
      return createJsonResponse({
        status: "success",
        version: SCRIPT_VERSION,
        time: new Date().toLocaleTimeString(),
        note: "Complete V19 - Universal Date Support"
      });
    }

    // 2. Fetch Pricing
    if (action === "fetchpricing") {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
      const data = sheet.getRange("I2:J8").getValues();
      const pricing = {};
      data.forEach(row => {
        if (row[0]) {
          const dayName = row[0].toString().trim().toLowerCase();
          pricing[dayName] = row[1];
        }
      });
      return createJsonResponse({ status: "success", pricing: pricing });
    }

    else if (action === "fetchregistrations") {
      let targetDate = params.date;
      if (!targetDate || targetDate === "undefined") {
        return createJsonResponse({ status: "error", message: "Valid Date required (received: " + targetDate + ")" });
      }

      const registrations = scanSheetForRegistrations(targetDate);
      return createJsonResponse({ status: "success", registrations: registrations });
    }

    // 4. Fetch Dashboard Stats
    else if (action === "fetchdashboardstats") {
      const stats = calculateDashboardStats();
      return createJsonResponse({ status: "success", stats: stats });
    }

    // 5. Check Drive Folder Access
    else if (action === "checkdrivefolder") {
      try {
        const folder = DriveApp.getFolderById(FOLDER_ID);
        return createJsonResponse({
          status: "success",
          folderName: folder.getName(),
          message: "Access verified!"
        });
      } catch (err) {
        return createJsonResponse({ status: "error", message: "Folder access error: " + err.toString() });
      }
    }

    // 6. DEFAULT: Availability Check (for booking page)
    else {
      let date = params.date;
      if (!date || date === "undefined") {
        return createJsonResponse({
          status: "error",
          message: "Date required for availability check",
          received_action: action || "none",
          received_params: JSON.stringify(params)
        });
      }

      const scriptProps = PropertiesService.getScriptProperties();
      const cacheKey = "booked_" + date;
      let bookedData = scriptProps.getProperty(cacheKey);

      if (bookedData === null) {
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
        const bookedArray = scanSheetForBookedSlots(date, sheet);
        bookedData = bookedArray.join(",");
        scriptProps.setProperty(cacheKey, bookedData);
      }

      const result = bookedData ? bookedData.split(",") : [];
      return createJsonResponse({ status: "success", bookedSlots: result });
    }

  } catch (error) {
    return createJsonResponse({ status: "error", message: "Global error: " + error.toString(), version: SCRIPT_VERSION });
  }
}

/**
 * Universal Date Parser: Handles Date objects and various string formats.
 */
function parseDateToString(d) {
  if (!d) return "";
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");

  let s = d.toString().trim();
  // If it's DD/MM/YYYY or DD-MM-YYYY, try to normalize
  if (s.includes("/") || s.includes("-")) {
    let parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
      // Check if it's YYYY at the end or beginning
      if (parts[0].length === 4) return parts[0] + "-" + parts[1].padStart(2, '0') + "-" + parts[2].padStart(2, '0');
      if (parts[2].length === 4) return parts[2] + "-" + parts[1].padStart(2, '0') + "-" + parts[0].padStart(2, '0');
    }
  }
  return s;
}

/**
 * Robust POST Handler: Bookings, Orders, & Pricing Updates.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No data received. STOP! Do not click 'Run' on doPost in the script editor. It only works when triggered by your website.");
    }

    const postData = JSON.parse(e.postData.contents);
    if (!postData) throw new Error("Could not parse JSON payload");

    const action = postData.action;

    if (action === "createOrder") {
      return handleCreateOrder(postData);
    } else if (action === "verifyAndSave") {
      return handleVerifyAndSave(postData);
    } else if (action === "updatePricing") {
      return handleUpdatePricing(postData);
    } else {
      throw new Error("Invalid action: " + action);
    }
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Updates pricing in Sheet1 Range I2:J8
 */
function handleUpdatePricing(data) {
  // Defensive check for manual execution in IDE
  if (!data || typeof data !== "object" || !data.day) {
    throw new Error("Missing data in handleUpdatePricing. STOP! Do not click 'Run' on this function in the script editor. Use your admin.html webpage instead.");
  }

  const day = data.day.toString().trim().toLowerCase();
  const newPrice = data.price;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const dataRange = sheet.getRange("I2:I8");
  const days = dataRange.getValues();

  let foundRow = -1;
  for (let i = 0; i < days.length; i++) {
    if (days[i][0].toString().trim().toLowerCase() === day) {
      foundRow = i + 2;
      break;
    }
  }

  if (foundRow === -1) throw new Error("Day not found: " + day);

  sheet.getRange(foundRow, 10).setValue(newPrice);
  return createJsonResponse({ status: "success", message: "Price updated for " + day });
}

function handleCreateOrder(data) {
  if (!data || !data.amount) throw new Error("Amount missing");
  const amount = parseInt(data.amount);

  const payload = {
    amount: amount,
    currency: "INR",
    receipt: "turf_" + Date.now()
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Basic " + Utilities.base64Encode(RZP_KEY_ID + ":" + RZP_KEY_SECRET)
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch("https://api.razorpay.com/v1/orders", options);
  const orderData = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    throw new Error("Razorpay API Error: " + (orderData.error ? orderData.error.description : "Unknown"));
  }

  return createJsonResponse({
    status: "success",
    orderId: orderData.id,
    amount: orderData.amount,
    currency: orderData.currency,
    key_id: RZP_KEY_ID
  });
}

function handleVerifyAndSave(data) {
  if (!data || !data.razorpay_order_id) throw new Error("Missing verification payload");
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingData, photoIdData, photoIdName } = data;

  // 1. Verify Signature
  const text = razorpay_order_id + "|" + razorpay_payment_id;
  const signature = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, text, RZP_KEY_SECRET)
    .map(e => {
      var v = (e < 0 ? e + 256 : e).toString(16);
      return v.length == 1 ? "0" + v : v;
    }).join("");

  if (signature !== razorpay_signature) throw new Error("Verification failed");

  // 2. Double-Booking Check
  const scriptProps = PropertiesService.getScriptProperties();
  const dateStr = bookingData.Select_Date;
  const requestedSlots = (bookingData["Select Time Slots (500 per hr)"] || "").split(",").map(s => s.trim()).filter(s => s);

  const cacheKey = "booked_" + dateStr;
  const alreadyBooked = (scriptProps.getProperty(cacheKey) || "").split(",").filter(s => s);
  const conflicts = requestedSlots.filter(s => alreadyBooked.includes(s));
  if (conflicts.length > 0) throw new Error("Double booked!");

  // 3. Photo ID Upload
  let photoIdUrl = "";
  if (photoIdData) {
    photoIdUrl = saveToSpecificFolder(photoIdData, photoIdName || "photo_id.jpg");
  }

  // 4. Save to Sheet (Targeting Cols A-G specifically to avoid gaps from I:J pricing table)
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, 7).getValues()[0];
  const row = new Array(headers.length).fill("");

  headers.forEach((header, index) => {
    const h = header.toString().trim();
    const hLower = h.toLowerCase().replace(/_/g, "");

    // PRIORITY 1: Force System Overrides
    if (hLower === "paymentstatus") {
      row[index] = "Success";
    } else if (hLower === "transactionid") {
      row[index] = razorpay_payment_id;
    } else if (hLower === "timestamp") {
      row[index] = new Date().toLocaleString();
    } else if (hLower.includes("photo") || hLower.includes("idproof") || hLower === "filelink") {
      row[index] = photoIdUrl;
    }
    // PRIORITY 2: Exact Match from form
    else if (bookingData[h]) {
      row[index] = bookingData[h];
    }
    // PRIORITY 3: Fuzzy Match (ignore underscores and case)
    else {
      for (let key in bookingData) {
        let keyClean = key.toLowerCase().replace(/_/g, "");
        if (hLower === keyClean) {
          row[index] = bookingData[key];
          break;
        }
      }
    }
  });

  // FIND NEXT ACTUAL ROW IN COL A (To ignore pricing table in I:J)
  const colAValues = sheet.getRange("A:A").getValues();
  let nextRow = 1;
  while (nextRow <= colAValues.length && colAValues[nextRow - 1][0] !== "") {
    nextRow++;
  }

  sheet.getRange(nextRow, 1, 1, headers.length).setValues([row]);

  // 5. Update Cache
  const updatedBooked = [...alreadyBooked, ...requestedSlots].join(",");
  scriptProps.setProperty(cacheKey, updatedBooked);

  return createJsonResponse({ status: "success", message: "Confirmed!" });
}

function scanSheetForBookedSlots(date, sheet) {
  // Defensive check for manual execution in IDE
  if (!date || !sheet) {
    throw new Error("STOP! Do not click 'Run' on scanSheetForBookedSlots in the script editor. This function only works when triggered by your website.");
  }
  const data = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 7).getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(h => h.toString().trim().toLowerCase().replace(/_/g, ""));
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const slotIdx = headers.findIndex(h => h.includes("slot"));
  if (dateIdx === -1 || slotIdx === -1) return [];
  const set = new Set();
  for (let i = 1; i < data.length; i++) {
    let d = data[i][dateIdx];
    let dStr = (d instanceof Date) ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd") : d.toString().trim();
    if (dStr === date) data[i][slotIdx].toString().split(",").forEach(s => { if (s.trim()) set.add(s.trim()); });
  }
  return Array.from(set);
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function AUTHORIZE_SCRIPT_MANUALLY() {
  Logger.log("Authorization Successful!");
}

/**
 * Test Razorpay API connectivity (safe to run manually in editor)
 */
function testRazorpayCall() {
  const response = UrlFetchApp.fetch("https://api.razorpay.com/v1/orders", {
    method: "get",
    headers: {
      "Authorization": "Basic " + Utilities.base64Encode(RZP_KEY_ID + ":" + RZP_KEY_SECRET)
    },
    muteHttpExceptions: true
  });
  Logger.log(response.getContentText());
}

/**
 * Test Pricing Data from Sheet (safe to run manually in editor)
 * Run this in the Script Editor to verify prices are being read correctly.
 */
function testFetchPricing() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  if (!sheet) {
    Logger.log("ERROR: Sheet '" + DATA_ENTRY_SHEET_NAME + "' not found! Check the sheet tab name.");
    return;
  }
  const data = sheet.getRange("I2:J8").getValues();
  Logger.log("Raw I2:J8 data: " + JSON.stringify(data));
  const pricing = {};
  data.forEach(row => {
    if (row[0]) {
      const dayName = row[0].toString().trim().toLowerCase();
      pricing[dayName] = row[1];
    }
  });
  Logger.log("Pricing (lowercase keys): " + JSON.stringify(pricing));
  Logger.log("✅ If you see all 7 days above with correct prices, the backend is working fine!");
}

/**
 * Scans the sheet for all registrations on a specific date.
 */
function scanSheetForRegistrations(date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const data = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 7).getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(h => h.toString().trim().toLowerCase().replace(/_/g, ""));
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const nameIdx = headers.findIndex(h => h.includes("name") || h.includes("user") || h.includes("client"));
  const mobileIdx = headers.findIndex(h => h.includes("mobile") || h.includes("phone") || h.includes("contact"));
  const ageIdx = headers.findIndex(h => h.includes("age"));
  const slotIdx = headers.findIndex(h => h.includes("slot") || h.includes("time"));
  const statusIdx = headers.findIndex(h => h.includes("status") || h.includes("payment"));

  Logger.log(`Scanning for date: ${date}. Found headers: ${headers.join(",")}`);
  if (dateIdx === -1) {
    Logger.log("ERROR: 'Date' column not found in Sheet1 headers.");
    return [];
  }

  const results = [];
  for (let i = 1; i < data.length; i++) {
    let dStr = parseDateToString(data[i][dateIdx]);

    if (dStr === date) {
      results.push({
        name: nameIdx !== -1 ? data[i][nameIdx] : "N/A",
        mobile: mobileIdx !== -1 ? data[i][mobileIdx] : "N/A",
        age: ageIdx !== -1 ? data[i][ageIdx] : "N/A",
        slots: slotIdx !== -1 ? data[i][slotIdx] : "N/A",
        status: statusIdx !== -1 ? data[i][statusIdx] : "N/A"
      });
    }
  }
  return results;
}

/**
 * Calculates real-time stats for the dashboard.
 */
function calculateDashboardStats() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const data = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 7).getValues();

  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const currentHr = new Date().getHours();

  if (data.length < 2) {
    return {
      todayBookings: 0,
      todayRevenue: 0,
      completedSlots: 0,
      remainingSlots: 24 - (currentHr + 1)
    };
  }

  const headers = data[0].map(h => h.toString().trim().toLowerCase().replace(/_/g, ""));
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const amountIdx = headers.findIndex(h => h.includes("amount") || h.includes("total") || h.includes("price"));
  const statusIdx = headers.findIndex(h => h.includes("status") || h.includes("payment"));
  const slotIdx = headers.findIndex(h => h.includes("slot") || h.includes("time"));

  if (dateIdx === -1 || slotIdx === -1) {
    return { todayBookings: 0, todayRevenue: 0, completedSlots: 0, remainingSlots: 0 };
  }

  let todayCount = 0;
  let todayRev = 0;
  let bookedSlotsForToday = [];

  for (let i = 1; i < data.length; i++) {
    const dStr = parseDateToString(data[i][dateIdx]);

    if (dStr === todayStr) {
      todayCount++;
      const row = data[i];
      const status = row[statusIdx] ? row[statusIdx].toString().toLowerCase() : "";
      if (status.includes("success") || status.includes("confirmed")) {
        todayRev += (parseFloat(row[amountIdx]) || 0);
      }

      // Collect booked slots to calculate "Remaining"
      const slots = data[i][slotIdx].toString().split(",");
      slots.forEach(s => { if (s.trim()) bookedSlotsForToday.push(s.trim()); });
    }
  }

  // Calculate Real-time status
  // A slot is "Completed" if its end hour is <= current hour
  // We assume slots are like "09 AM - 10 AM" (extracted hour is 9, end hour is 10)
  let completedCount = 0;
  bookedSlotsForToday.forEach(slot => {
    // Slot format: "HH AM/PM - HH AM/PM"
    const parts = slot.split("-");
    if (parts.length > 1) {
      let endPart = parts[1].trim(); // e.g. "10 AM"
      let hr = parseInt(endPart);
      let isPM = endPart.includes("PM");
      if (isPM && hr < 12) hr += 12;
      if (!isPM && hr === 12) hr = 0; // 12 AM is 0
      if (hr === 12 && endPart.includes("AM")) hr = 24; // Handle literal "12 AM" at end of day if exists

      if (hr <= currentHr) completedCount++;
    }
  });

  const totalPossibleToday = 24;
  const pastHours = currentHr + 1;
  const remainingSlots = Math.max(0, totalPossibleToday - pastHours - (bookedSlotsForToday.length - completedCount));

  return {
    todayBookings: todayCount,
    todayRevenue: todayRev,
    completedSlots: completedCount,
    remainingSlots: remainingSlots
  };
}

/**
 * Overwritten robust image saving function.
 */
function saveToSpecificFolder(base64Data, fileName) {
  try {
    if (!base64Data || !base64Data.includes(",")) {
      throw new Error("Invalid base64 payload received.");
    }

    // Auto-detect content type from base64 string
    const splitData = base64Data.split(',');
    const header = splitData[0];
    const base64Body = splitData[1];
    const contentType = header.substring(5, header.indexOf(';'));

    const bytes = Utilities.base64Decode(base64Body);
    const blob = Utilities.newBlob(bytes, contentType, fileName);

    const folder = DriveApp.getFolderById(FOLDER_ID);
    if (!folder) throw new Error("Folder not found or inaccessible: " + FOLDER_ID);

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
  } catch (e) {
    Logger.log("saveToSpecificFolder Error: " + e.toString());
    // Return a descriptive error that can be stored in the sheet for debugging
    return "UPLOAD_ERROR: " + e.message;
  }
}