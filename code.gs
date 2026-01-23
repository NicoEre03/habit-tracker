function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    // robustly get first sheet
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const action = e.parameter.action || (e.postData ? JSON.parse(e.postData.contents).action : "read");
    
    // Parse Payload
    let payload = {};
    if (e.postData) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (err) { }
    }
    
    let result = {};

    if (action === "read") {
      result = getSheetData(sheet);
    } 
    else if (action === "update") {
      const resultMsg = updateCell(sheet, payload);
      result = { status: resultMsg === "OK" ? "success" : "error", message: resultMsg };
    }
    else if (action === "addHabit") {
      addHabit(sheet, payload.name);
      result = { status: "success" };
    }
    else if (action === "deleteHabit") {
      deleteHabit(sheet, payload.rowIndex);
      result = { status: "success" };
    }
    else if (action === "renameHabit") {
      renameHabit(sheet, payload.rowIndex, payload.name);
      result = { status: "success" };
    }
    else if (action === "reorderHabit") {
      reorderHabit(sheet, payload.fromIndex, payload.toIndex);
      result = { status: "success" };
    }
    
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: e.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function getSheetData(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 1 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const notes = sheet.getRange(1, 1, lastRow, lastCol).getNotes();
  
  // Combine Values and Notes into [Header, Habit1, Habit2...]
  // Header: [null, Date1, Date2...]
  // Habit: [Name, {val:x, note:y}, ...]
  
  const grid = [];
  
  // 1. Process Header
  const headerRowFromSheet = values[0];
  const gridHeader = [null]; // First col is habit names
  
  // Format Dates ensuring consistency
  for (let c = 1; c < headerRowFromSheet.length; c++) {
    const rawDate = headerRowFromSheet[c];
    if (rawDate instanceof Date) {
      // YYYY-MM-DD
      const iso = Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
      gridHeader.push(iso);
    } else {
      // If it's a string or empty, just push
      gridHeader.push(rawDate);
    }
  }
  grid.push(gridHeader);
  
  // 2. Process Habits
  for (let r = 1; r < values.length; r++) {
    const rowVals = values[r];
    const rowNotes = notes[r];
    const habitName = rowVals[0];
    
    const habitRow = [habitName];
    
    for (let c = 1; c < rowVals.length; c++) {
      let val = rowVals[c];
      
      // Strict Normalization of Status
      // Empty string = 0 (Neutral)
      // Check for numbers. User wants -1, 0, 1, 2.
      if (val === "") val = 0;
      else val = Number(val);
      if (isNaN(val)) val = 0;

      habitRow.push({
        val: val,
        note: rowNotes[c] === "" ? null : rowNotes[c]
      });
    }
    grid.push(habitRow);
  }
  
  return grid;
}

function updateCell(sheet, data) {
  // data: { habitName, dateStr, val, note }
  
  const hRow = findRowByName(sheet, data.habitName);
  const dCol = findColByDate(sheet, data.dateStr);
  
  if (hRow > 0 && dCol > 0) {
    const cell = sheet.getRange(hRow, dCol);
    if (typeof data.val !== 'undefined') cell.setValue(data.val);
    if (typeof data.note !== 'undefined') cell.setNote(data.note || ""); // Native Note
    return "OK";
  } else {
    return `Lookup Failed: Row=${hRow} (Habit: ${data.habitName}), Col=${dCol} (Date: ${data.dateStr})`;
  }
}

function addHabit(sheet, name) {
  // Append to bottom
  sheet.appendRow([name]);
}

function deleteHabit(sheet, rowIndex) {
  // rowIndex is 0-based index of habits (excluding header).
  // Sheet Row = rowIndex + 2
  sheet.deleteRow(rowIndex + 2);
}

function renameHabit(sheet, rowIndex, newName) {
  sheet.getRange(rowIndex + 2, 1).setValue(newName);
}

function reorderHabit(sheet, fromIndex, toIndex) {
  // fromIndex, toIndex are 0-based habit indices (Grid data rows).
  // Habits start at Sheet Row 2.
  const sheetFrom = fromIndex + 2;
  const sheetTo = toIndex + 2; // Target 1-based index if we were just inserting
  
  // allow for moveRows logic: "inserts before the given index"
  // If moving down (from < to), the rows shift up, so we need to target +1 to end up AFTER the target's original position (which is now -1).
  // Simpler: Just map to the destination row index.
  // Example: Move 0 (Row 2) to 2 (Row 4). Target is Row 4.
  // moveRows(Row2, Dest).
  // Destination is "Before Row X".
  // If we want it at Row 4 (currently C). We want A, B, C -> B, C, A.
  // So we want it at Row 4 (index 2).
  // If we say: before Row 5 (empty/D). It becomes Row 4.
  // So Dest = 5. (SheetTo + 1).
  
  // Example: Move 2 (Row 4) to 0 (Row 2). Target is Row 2.
  // We want A, B, C -> C, A, B.
  // moveRows(Row4, Dest).
  // Before Row 2.
  // Dest = 2. (SheetTo).
  
  let dest = sheetTo;
  if (fromIndex < toIndex) {
    dest += 1;
  }
  
  const range = sheet.getRange(sheetFrom, 1); // Get the row
  sheet.moveRows(range, dest);
}

// Helpers
function findRowByName(sheet, name) {
  // Fetch only the first column
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] == name) return i + 2;
  }
  return -1;
}

function findColByDate(sheet, dateStr) {
  // Robust Date Matching
  // Header row is Row 1. B1 is 1st date (Col 2).
  const lastCol = sheet.getLastColumn();
  if (lastCol < 2) return -1;
  
  const headers = sheet.getRange(1, 2, 1, lastCol - 1).getValues()[0];
  
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    let hStr = "";
    
    if (h instanceof Date) {
      hStr = Utilities.formatDate(h, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else {
      // Try to parse string
      // If user typed "1/1/2026", new Date() might parse it
      const pd = new Date(h);
      if (!isNaN(pd.getTime())) {
         hStr = Utilities.formatDate(pd, Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
         hStr = String(h);
      }
    }
    
    // Strict match YYYY-MM-DD
    if (hStr === dateStr) return i + 2; // Col index (1-based, +2 offset)
  }
  return -1;
}
