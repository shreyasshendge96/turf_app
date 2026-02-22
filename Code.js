const DATA_ENTRY_SHEET_NAME = "Sheet1";
const SCRIPT_VERSION = "V10-SPECIFIC-FOLDER";
const FOLDER_ID = "11_1y25b-VrUr1qNGY1_dELhyT1Ixuyk6"; // Provided by User

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
        note: "Specific Folder ID Integrated"
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
      throw new Error("Invalid action");
    }
  } catch (error) {
    return createJsonResponse({ status: "error", message: error.toString() });
  }
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

  // 3. User Requested Photo ID Upload Logic
  let photoIdUrl = "";
  if (photoIdData) {
    photoIdUrl = saveToSpecificFolder(photoIdData, photoIdName || "photo_id.jpg");
  }

  // 4. Save to Sheet
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_ENTRY_SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = new Array(headers.length).fill("");

  headers.forEach((header, index) => {
    const h = header.toString().trim();
    const hLower = h.toLowerCase();

    if (hLower === "payment_status") {
      row[index] = "Success";
    } else if (hLower === "transaction_id") {
      row[index] = razorpay_payment_id;
    } else if (hLower === "timestamp") {
      row[index] = new Date().toLocaleString();
    } else if (hLower.includes("photo") || hLower.includes("id_proof") || hLower === "filelink") {
      row[index] = photoIdUrl;
    } else if (bookingData[h]) {
      row[index] = bookingData[h];
    } else {
      for (let key in bookingData) {
        if (h.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(h.toLowerCase())) {
          row[index] = bookingData[key];
          break;
        }
      }
    }
  });

  sheet.appendRow(row);

  // 5. Update Cache
  const updatedBooked = [...alreadyBooked, ...requestedSlots].join(",");
  scriptProps.setProperty(cacheKey, updatedBooked);

  return createJsonResponse({ status: "success", message: "Confirmed!" });
}

/**
 * Saves a file to the SPECIFIC folder ID provided by the user
 */
function saveToSpecificFolder(base64Data, fileName) {
  try {
    const contentType = base64Data.substring(5, base64Data.indexOf(';'));
    const bytes = Utilities.base64Decode(base64Data.split(',')[1]);
    const blob = Utilities.newBlob(bytes, contentType, fileName);

    const folder = DriveApp.getFolderById(FOLDER_ID);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // User's preferred direct view format
    return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
  } catch (e) {
    Logger.log("Drive upload error: " + e.toString());
    return "Error saving photo: " + e.toString();
  }
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

function setupDailyRefreshTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => { if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(0).everyDays(1).create();
}
