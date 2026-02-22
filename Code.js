const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V8-ROBUST-PAYMENT";

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
        note: "Secure Payments Active"
      });
    }

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
 * Robust POST Handler
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No data received in post body");
    }

    const postData = JSON.parse(e.postData.contents);
    if (!postData) throw new Error("Could not parse JSON payload");

    const action = postData.action;

    if (action === "createOrder") {
      return handleCreateOrder(postData);
    } else if (action === "verifyAndSave") {
      return handleVerifyAndSave(postData);
    } else {
      throw new Error("Invalid action: " + action);
    }
  } catch (error) {
    Logger.log("doPost Error: " + error.toString());
    return createJsonResponse({ status: "error", message: error.toString() });
  }
}

/**
 * Step 1: Create Razorpay Order securely
 */
function handleCreateOrder(data) {
  if (!data || !data.amount) throw new Error("Amount is missing");

  const amount = parseInt(data.amount); // in paise
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount value");

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

/**
 * Step 2: Verify Payment & Save Data
 */
function handleVerifyAndSave(data) {
  if (!data) throw new Error("Verification data missing");

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingData } = data;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingData) {
    throw new Error("Missing payment verification details or booking data");
  }

  // 1. Signature Verification
  const text = razorpay_order_id + "|" + razorpay_payment_id;
  const signature = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, text, RZP_KEY_SECRET)
    .map(function (e) {
      var v = (e < 0 ? e + 256 : e).toString(16);
      return v.length == 1 ? "0" + v : v;
    }).join("");

  if (signature !== razorpay_signature) {
    throw new Error("Payment signature mismatch!");
  }

  // 2. Double-Booking Check
  const scriptProps = PropertiesService.getScriptProperties();
  const dateStr = bookingData.Select_Date;
  const requestedSlotsStr = bookingData["Select Time Slots (500 per hr)"] || "";
  const requestedArray = requestedSlotsStr.split(",").map(s => s.trim()).filter(s => s);

  const cacheKey = "booked_" + dateStr;
  const cachedStr = scriptProps.getProperty(cacheKey) || "";
  const alreadyBooked = cachedStr.split(",").filter(s => s);
  const conflicts = requestedArray.filter(s => alreadyBooked.includes(s));

  if (conflicts.length > 0) {
    throw new Error("Slots just occupied by another user: " + conflicts.join(", "));
  }

  // 3. Exact Field Mapping
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = new Array(headers.length).fill("");

  headers.forEach((header, index) => {
    const h = header.toString().trim();
    // Use exact matches or common variations
    if (bookingData[h]) {
      row[index] = bookingData[h];
    } else if (h === "Payment_Status") {
      row[index] = "Success";
    } else if (h === "Transaction_ID") {
      row[index] = razorpay_payment_id;
    } else if (h === "Timestamp") {
      row[index] = new Date().toLocaleString();
    } else {
      // Fallback fuzzy
      for (let key in bookingData) {
        if (h.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(h.toLowerCase())) {
          row[index] = bookingData[key];
          break;
        }
      }
    }
  });

  sheet.appendRow(row);

  // 4. Update Cache
  const updatedBooked = [...alreadyBooked, ...requestedArray].join(",");
  scriptProps.setProperty(cacheKey, updatedBooked);

  return createJsonResponse({ status: "success", message: "Booking saved successfully!" });
}

function dailyRefresh() {
  PropertiesService.getScriptProperties().deleteAllProperties();
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
