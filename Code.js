const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V7-RAZORPAY-INTEGRATION";

// RAZORPAY CREDENTIALS (TEST MODE)
const RZP_KEY_ID = "rzp_test_SJ6lquRPN8TtH1";
const RZP_KEY_SECRET = "82ozyK7jcQBAB2NMPIyErDJU";

/**
 * Handles GET requests: Availability & Version Check.
 */
function doGet(e) {
  try {
    if (e.parameter.check === "version") {
      return createJsonResponse({
        status: "success",
        version: SCRIPT_VERSION,
        time: new Date().toLocaleTimeString(),
        note: "Razorpay Integration Active"
      });
    }

    const date = e.parameter.date;
    if (!date) return createJsonResponse({ status: "error", message: "Date required" });

    const scriptProps = PropertiesService.getScriptProperties();
    const cacheKey = "booked_" + date;
    let currentBookedSlotsStr = scriptProps.getProperty(cacheKey);

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
 * Handles POST requests: 
 * 1. Create Razorpay Order
 * 2. Verify Payment & Save Booking
 */
function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents || "{}");
    const action = postData.action;

    if (action === "createOrder") {
      return handleCreateOrder(postData);
    } else if (action === "verifyAndSave") {
      return handleVerifyAndSave(postData);
    } else {
      throw new Error("Invalid action");
    }
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Step 1: Create Razorpay Order securely
 */
function handleCreateOrder(data) {
  const amount = parseInt(data.amount); // amount in paise (e.g. 50000 for ₹500)
  if (!amount || amount <= 0) throw new Error("Invalid amount");

  const payload = {
    amount: amount,
    currency: "INR",
    receipt: "receipt_" + Date.now()
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Basic " + Utilities.base64Encode(RZP_KEY_ID + ":" + RZP_KEY_SECRET)
    },
    payload: JSON.stringify(payload)
  };

  const response = UrlFetchApp.fetch("https://api.razorpay.com/v1/orders", options);
  const orderData = JSON.parse(response.getContentText());

  return createJsonResponse({
    status: "success",
    orderId: orderData.id,
    amount: orderData.amount,
    currency: orderData.currency,
    key_id: RZP_KEY_ID
  });
}

/**
 * Step 2: Verify Payment Signature & Save Data
 */
function handleVerifyAndSave(data) {
  const razorpay_order_id = data.razorpay_order_id;
  const razorpay_payment_id = data.razorpay_payment_id;
  const razorpay_signature = data.razorpay_signature;
  const bookingData = data.bookingData; // The actual form data

  // 1. Verify Signature
  const secret = RZP_KEY_SECRET;
  const signatureData = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, signatureData, secret)
    .map(function (e) {
      var v = (e < 0 ? e + 256 : e).toString(16);
      return v.length == 1 ? "0" + v : v;
    }).join("");

  if (expectedSignature !== razorpay_signature) {
    throw new Error("Payment verification failed! Invalid signature.");
  }

  // 2. Double-Booking Check (Server-Side)
  const scriptProps = PropertiesService.getScriptProperties();
  const date = bookingData.Select_Date;
  const requestedSlotsStr = bookingData["Select Time Slots (500 per hr)"] || "";
  const requestedSlotsArray = requestedSlotsStr.split(",").map(s => s.trim()).filter(s => s);

  const cacheKey = "booked_" + date;
  const currentCachedStr = scriptProps.getProperty(cacheKey) || "";
  const alreadyBookedArray = currentCachedStr.split(",").filter(s => s);
  const conflicts = requestedSlotsArray.filter(s => alreadyBookedArray.includes(s));

  if (conflicts.length > 0) {
    // If double booked, we might need to refund the payment manually or show error.
    // For this implementation, we block the save.
    throw new Error("Payment successful, but slot was just taken! Conflicts: " + conflicts.join(", "));
  }

  // 3. Save to Sheet
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headerMap = {};
  headers.forEach((h, i) => headerMap[h.toString().trim().toLowerCase()] = i);

  const rowToAppend = new Array(headers.length).fill("");

  // Fill from bookingData
  Object.keys(bookingData).forEach(key => {
    const normKey = key.trim().toLowerCase();
    if (headerMap.hasOwnProperty(normKey)) {
      rowToAppend[headerMap[normKey]] = bookingData[key];
    } else {
      for (let h in headerMap) {
        if (h.includes(normKey) || normKey.includes(h)) {
          rowToAppend[headerMap[h]] = bookingData[key];
          break;
        }
      }
    }
  });

  // Explicitly update Payment Status and Transaction ID
  if (headerMap.hasOwnProperty("payment_status")) rowToAppend[headerMap["payment_status"]] = "Success";
  if (headerMap.hasOwnProperty("transaction_id")) rowToAppend[headerMap["transaction_id"]] = razorpay_payment_id;
  if (headerMap.hasOwnProperty("timestamp")) rowToAppend[headerMap["timestamp"]] = new Date().toLocaleString();

  sheet.appendRow(rowToAppend);

  // 4. Update Fast Cache
  const newBookedStr = [...alreadyBookedArray, ...requestedSlotsArray].join(",");
  scriptProps.setProperty(cacheKey, newBookedStr);

  return createJsonResponse({ status: "success", message: "Booking confirmed and payment verified!" });
}

function dailyRefresh() {
  const scriptProps = PropertiesService.getScriptProperties();
  scriptProps.deleteAllProperties();
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
