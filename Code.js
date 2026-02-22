const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V18-COMPLETE";
const FOLDER_ID = "11_1y25b-VrUr1qNGY1_dELhyT1Ixuyk6";

// RAZORPAY CREDENTIALS (TEST MODE)
const RZP_KEY_ID = "rzp_test_SJ6lquRPN8TtH1";
const RZP_KEY_SECRET = "82ozyK7jcQBAB2NMPIyErDJU";

/**
 * Handles GET requests: Availability, Version, & Pricing Check.
 */
function doGet(e) {
  try {
    const action = e.parameter.action;

    // 1. Version Check
    if (e.parameter.check === "version") {
      return createJsonResponse({
        status: "success",
        version: SCRIPT_VERSION,
        time: new Date().toLocaleTimeString(),
        note: "Complete V18 - All fixes included"
      });
    }

    // 2. Fetch Pricing (Reads from Sheet1 Range I2:J8)
    // Day names are stored lowercase for robust matching on frontend
    if (action === "fetchPricing") {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
      const data = sheet.getRange("I2:J8").getValues();
      const pricing = {};
      data.forEach(row => {
        if (row[0]) {
          const dayName = row[0].toString().trim().toLowerCase();
          pricing[dayName] = row[1];
        }
      });
      return createJsonResponse({
        status: "success",
        pricing: pricing,
        keysFound: Object.keys(pricing) // Debug: see exact sheet keys
      });
    }

    // 3. Availability Check
    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

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

  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
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

function saveToSpecificFolder(base64Data, fileName) {
  try {
    // Auto-detect content type from base64 string
    const contentType = base64Data.substring(5, base64Data.indexOf(';'));
    const bytes = Utilities.base64Decode(base64Data.split(',')[1]);
    const blob = Utilities.newBlob(bytes, contentType, fileName);
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
  } catch (e) {
    return "Error saving photo: " + e.toString();
  }
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