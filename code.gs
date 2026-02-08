function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
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
      processHabitStates(sheet); // Calc logic before read
      result = getSheetData(sheet);
    } 
    else if (action === "update") {
      const resultMsg = updateCell(sheet, payload);
      SpreadsheetApp.flush(); // Enforce write
      processHabitStates(sheet); 
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
    else if (action === "updateHabitPeriodicity") {
      updateHabitPeriodicity(sheet, payload.rowIndex, payload.periodicity);
      SpreadsheetApp.flush(); // Enforce write
      processHabitStates(sheet); 
      result = { status: "success" };
    }
    else if (action === "saveSnapshot") {
      savePeriodicitySnapshot(sheet);
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

function processHabitStates(sheet) {
  // 1. Get All Data
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 3) return; 

  const headers = sheet.getRange(1, 3, 1, lastCol - 2).getValues()[0]; 
  const dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const data = dataRange.getValues(); 
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Helper to parse date from header
  const parsedDates = headers.map(h => {
    if (h instanceof Date) return h;
    const d = new Date(h);
    return isNaN(d.getTime()) ? null : d;
  });

  // --- HISTORY LOOKUP SYSTEM ---
  let historyMap = null; // Map<HabitName, Array<{date: Date, freq: String}>>
  const ss = sheet.getParent();
  const hSheet = ss.getSheetByName("PeriodicityHistory");
  
  if (hSheet) {
      historyMap = {};
      const hLastRow = hSheet.getLastRow();
      const hLastCol = hSheet.getLastColumn();
      if (hLastRow > 1 && hLastCol > 1) {
          const hData = hSheet.getRange(1, 1, hLastRow, hLastCol).getValues();
          const hHeaders = hData[0];
          
          // Parse Header Dates
          const snapDates = [];
          for (let c = 1; c < hHeaders.length; c++) {
              let d = hHeaders[c];
              if (!(d instanceof Date)) d = new Date(d);
              if (!isNaN(d)) snapDates.push({ date: d, colIdx: c });
          }
          // Sort snapshots by date just in case
          snapDates.sort((a,b) => a.date - b.date);

          // Build Map
          for (let r = 1; r < hData.length; r++) {
              const hName = hData[r][0];
              const historyList = [];
              snapDates.forEach(snap => {
                  const val = hData[r][snap.colIdx];
                  historyList.push({ date: snap.date, freq: String(val || "").trim().toLowerCase() });
              });
              historyMap[hName] = historyList;
          }
      }
  }

  // 2. Iterate Habits
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const name = row[0];
    const livePeriodicity = String(row[1] || "1/d").trim().toLowerCase(); 

    // Define function to get target for a specific date
    // Creates a closure over the history data for this habit
    const getTargetForDate = (dateObj) => {
        let pStr = livePeriodicity;
        
        if (historyMap && historyMap[name] && historyMap[name].length > 0) {
            const list = historyMap[name];
            // Find latest snapshot <= dateObj
            // Logic: "Effective Date". 
            // If dateObj is BEFORE the first snapshot, usage depends on user intent.
            // PROPOSAL: Use the OLDEST snapshot as the default for all past time.
            // If we fall back to "Live", then "Live" edits change history, which defeats the purpose.
            
            // 1. Find matched snapshot
            let bestSnap = null;
            for (let i = 0; i < list.length; i++) {
                if (list[i].date <= dateObj) {
                    bestSnap = list[i];
                } else {
                    break; // Sorted ascending, so once we pass dateObj, we stop
                }
            }
            
            // 2. Fallback if dateObj is older than all snapshots
            if (!bestSnap) {
                 bestSnap = list[0]; // Use the oldest as "Origin"
            }
            
            pStr = bestSnap.freq;
        }

        if (!pStr) return null; // Empty in history -> Habit didn't exist -> No Calc

        const match = pStr.match(/(\d+)\/([dwm])/);
        if (match) {
            return { target: parseInt(match[1], 10), type: match[2] };
        }
        return { target: 1, type: 'd' }; // Default? Or null? '1/d' default seems safe.
    };

    // We can't simply group by 'd/w/m' for the whole row anymore because type might CHANGE.
    // e.g. Jan=Daily, Feb=Weekly.
    // Complex! processPeriodHabit assumes a single type for the row.
    
    // NEW STRATEGY: 
    // We must segment the row by Period Type first? 
    // Or just iterate periods and check type for each?
    // Dates are columns. 
    // The "Periods" (Weeks/Months) are buckets of columns.
    // If on Jan 31 (Week 5) the rule is "Weekly", we treat that week as Weekly.
    // If on Jan 31 the rule is "Daily", we treat that day as Daily.
    
    // To solve this efficiently:
    // 1. Group columns into "Calculation Units" (Days)
    // 2. For each Day, determine the Rule.
    // 3. If Rule is Daily -> Process immediately.
    // 4. If Rule is Weekly -> Add to "Current Week Bucket". If bucket finishes or Rule changes type -> Process Bucket.
    
    // Actually, "Rule changes type mid-week" is messy. 
    // Simplification: The rule effectively at the END of the period governs the period.
    // e.g. If on Sunday (end of week) the rule is "3/w", the whole week is judged by "3/w".
    
    // Let's iterate all dates and group them into potential buckets.
    
    // Bucket Types: D, W, M
    const bucket = { type: null, key: null, days: [] };
    
    // Helper to process a bucket
    const flushBucket = () => {
        if (!bucket.days.length) return;
        
        if (bucket.type === 'd') {
            // Process individual days
             processDailyHabitSimple(sheet, r + 2, bucket.days, today);
        } else if (bucket.type) {
            // W or M
            const target = bucket.target; // Saved from the trigger moment
            processPeriodHabitSimple(sheet, r + 2, bucket.days, target, today, bucket.type);
        }
        // Reset
        bucket.type = null;
        bucket.key = null;
        bucket.days = [];
    };

    for (let c = 2; c < row.length; c++) {
        const date = parsedDates[c - 2];
        if (!date) continue;
        
        // Lookup Rule for this date
        const rule = getTargetForDate(date);
        
        if (!rule) {
            // No rule (empty history) -> skip calc (do not flush pending? maybe flush pending).
            // If I had a week pending and now I have no rule, that week is "over".
            flushBucket();
            continue; 
        }

        // Determine Key for this rule type
        let key = "";
        if (rule.type === 'd') key = date.getTime(); // Unique per day
        else if (rule.type === 'w') key = getWeekKey(date);
        else if (rule.type === 'm') key = getMonthKey(date);
        
        // Check consistency with current bucket
        if (bucket.key !== key || bucket.type !== rule.type) {
            // Context switch! Flush old calc.
            flushBucket();
            
            // Start new
            bucket.type = rule.type;
            bucket.key = key;
            bucket.target = rule.target; // Use target from the start of the bucket? Or end?
            // "End of period" logic implies we keep updating target? 
            // Let's use the target associated with the 'current' date being added,
            // effectively determining the rule by the "chunks" defined by change.
            // If I change Mon(1/w) to Tue(2/w).
            // Mon was in "Week X". Tue is in "Week X".
            // Key is same. Type is same.
            // Target changed.
            // Do we flush?
            // If we flush, we judge Mon by 1/w (1 day, 0 done). Fail? No, weekly needs 7 days.
            // So we MUST NOT flush if only target changes within same period key.
            // We should implicitly adopt the latest target for the period?
            // Yes. "End of week rule applies".
            bucket.target = rule.target; 
        } else {
             // Same bucket, just update target to latest (End of Period Logic)
             bucket.target = rule.target;
        }
        
        bucket.days.push({
            colIdx: c + 1,
            val: row[c],
            date: date
        });
    }
    // Flush end
    flushBucket();
  }
}

// --- SIMPLIFIED PROCESSORS ---
// Adapted from original processDaily/PeriodHabit but taking pre-built 'days' array

function processDailyHabitSimple(sheet, rowIdx, days, today) {
    days.forEach(d => {
        if (d.date < today) {
             if (d.val === "" || d.val === 0 || d.val === -2) {
                 sheet.getRange(rowIdx, d.colIdx).setValue(-1);
             }
        }
    });
}

function processPeriodHabitSimple(sheet, rowIdx, days, target, today, type) {
    const doneCount = days.filter(d => d.val == 1 || d.val == 2).length; 
    const lastDateInPeriod = days[days.length - 1].date;
    const isPeriodEnded = isPeriodStrictlyPast(lastDateInPeriod, today, type);

    if (isPeriodEnded) {
      let failedNeeded = Math.max(0, target - doneCount);
      const nonDone = days.filter(d => d.val !== 1 && d.val !== 2);
      
      nonDone.sort((a, b) => {
        const getScore = (v) => {
             if (v === -1) return 0;
             if (v === 0 || v === "") return 1;
             return 2;
        };
        return getScore(a.val) - getScore(b.val) || (Math.random() - 0.5);
      });
      
      for (let i = 0; i < nonDone.length; i++) {
        const item = nonDone[i];
        let newVal = (i < failedNeeded) ? -1 : -2;
        const currentVal = (item.val === "") ? 0 : item.val;
        if (currentVal !== newVal) {
             sheet.getRange(rowIdx, item.colIdx).setValue(newVal);
        }
      }
    } else {
      // Period Ongoing
      const futureOrTodayDays = days.filter(d => d.date >= today).length;
      if ((doneCount + futureOrTodayDays) >= target) {
         const passedNeutral = days.filter(d => d.date < today && (d.val === "" || d.val === 0));
         passedNeutral.forEach(d => {
            sheet.getRange(rowIdx, d.colIdx).setValue(-2);
         });
      }
    }
}

// --- END PROCESSORS ---

function getWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
  return d.getUTCFullYear() + "-W" + String(weekNo).padStart(2, '0');
}

function getMonthKey(date) {
  return date.getFullYear() + "-" + (date.getMonth() + 1);
}

function isPeriodStrictlyPast(dateInPeriod, today, type) {
    if (type === 'w') {
        const currentWeek = getWeekKey(today);
        const periodWeek = getWeekKey(dateInPeriod);
        return periodWeek < currentWeek; // String comparison works for YYYY-Www
    } else {
        const currentMonth = getMonthKey(today); // "2026-2"
        const periodMonth = getMonthKey(dateInPeriod);
        // Compare carefully. "2025-12" < "2026-1"
        // Convert to value
        const [y1, m1] = currentMonth.split('-').map(Number);
        const [y2, m2] = periodMonth.split('-').map(Number);
        return (y2 < y1) || (y2 === y1 && m2 < m1);
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
  const gridHeader = [null, null]; 
  
  // Format Dates ensuring consistency. Header now starts at Col 3 (Index 2)
  for (let c = 2; c < headerRowFromSheet.length; c++) {
    const rawDate = headerRowFromSheet[c];
    if (rawDate instanceof Date) {
      const iso = Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
      gridHeader.push(iso);
    } else {
      gridHeader.push(rawDate);
    }
  }
  grid.push(gridHeader);
  
  // --- SYNC: Get Effective Periodicity for Today from History ---
  const today = new Date();
  today.setHours(0,0,0,0);
  let historyMap = {}; 
  
  const ss = sheet.getParent();
  const hSheet = ss.getSheetByName("PeriodicityHistory");
  if (hSheet) {
      const hLastCol = hSheet.getLastColumn();
      const hLastRow = hSheet.getLastRow();
      if (hLastCol > 1 && hLastRow > 1) {
          const hHeaders = hSheet.getRange(1, 1, 1, hLastCol).getValues()[0];
          
          // Find latest snapshot <= Today
          let bestSnapIdx = -1; // 1-based col index relative to sheet? Header array is 0-based.
          let bestSnapDate = new Date(0); // Epoch
          
          // Headers[1] starts the snapshots (Col 2)
          for (let c = 1; c < hHeaders.length; c++) {
             let d = hHeaders[c];
             if (!(d instanceof Date)) d = new Date(d);
             if (isNaN(d.getTime())) continue;
             
             if (d <= today && d >= bestSnapDate) {
                 bestSnapDate = d;
                 bestSnapIdx = c; // Index in hHeaders array. Sheet Col = c + 1
             }
          }
          
          // If found, load that column
          // If NOT found (all snapshots are in future??), maybe use oldest? 
          // Similar logic to processHabitStates: "Origin Rule".
          if (bestSnapIdx === -1) {
             // Fallback: Use the First Snapshot (Index 1) if it exists, as the "Origin"
             if (hHeaders.length > 1) bestSnapIdx = 1;
          }
          
          if (bestSnapIdx !== -1) {
              const snapColIdx = bestSnapIdx + 1; // 1-based for getRange
              const hData = hSheet.getRange(2, 1, hLastRow - 1, hLastCol).getValues(); // Get all data? 
              // Optimization: Just get Name col and Snap col
              // But getRange is contiguous. 
              // Let's just Loop the already fetched 'hData' if we fetched it? 
              // We didn't fetch full data yet.
              // Fetch Name Col and Target Col.
              const names = hSheet.getRange(2, 1, hLastRow - 1, 1).getValues();
              const values = hSheet.getRange(2, snapColIdx, hLastRow - 1, 1).getValues();
              
              for (let i = 0; i < names.length; i++) {
                  const n = names[i][0];
                  const v = values[i][0];
                  if (n) historyMap[n] = v;
              }
          }
      }
  }

  // 2. Process Habits
  for (let r = 1; r < values.length; r++) {
    const rowVals = values[r];
    const rowNotes = notes[r];
    const habitName = rowVals[0];
    
    // SYNC LOGIC: Check map first, fallback to Live Column
    let periodicity = historyMap[habitName];
    if (periodicity === undefined || periodicity === "") {
        periodicity = rowVals[1]; // Fallback to Live
    }
    
    // Output row: [Name, Period, Val1, Val2...]
    const habitRow = [habitName, periodicity];
    
    for (let c = 2; c < rowVals.length; c++) {
      let val = rowVals[c];
      
      // Strict Normalization of Status
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
    if (typeof data.note !== 'undefined') cell.setNote(data.note || ""); 
    return "OK";
  } else {
    // Debug info
    return `Lookup Failed: Row=${hRow} (Name: ${data.habitName}), Col=${dCol} (Date: ${data.dateStr})`;
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

function updateHabitPeriodicity(sheet, rowIndex, newPeriod) {
   // rowIndex is 0-based index of habits (Grid rows).
   // Sheet Row = rowIndex + 2.
   // Periodicity is Column 2.
   sheet.getRange(rowIndex + 2, 2).setValue(newPeriod);
}

function savePeriodicitySnapshot(sheet) {
  const ss = sheet.getParent();
  let historySheet = ss.getSheetByName("PeriodicityHistory");
  if (!historySheet) {
    historySheet = ss.insertSheet("PeriodicityHistory");
    historySheet.appendRow(["Habit Name"]); // Init Header
  }
  
  // 1. Setup Date Column
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const hLastCol = Math.max(1, historySheet.getLastColumn());
  const headers = historySheet.getRange(1, 1, 1, hLastCol).getValues()[0];
  
  let dateColIdx = -1; // 1-based
  for (let i = 1; i < headers.length; i++) { // Skip Col 1 (Name)
     let hStr = "";
     if (headers[i] instanceof Date) {
        hStr = Utilities.formatDate(headers[i], Session.getScriptTimeZone(), "yyyy-MM-dd");
     } else {
        hStr = String(headers[i]);
     }
     if (hStr === todayStr) {
         dateColIdx = i + 1;
         break;
     }
  }
  
  if (dateColIdx === -1) {
      dateColIdx = hLastCol + 1;
      historySheet.getRange(1, dateColIdx).setValue(todayStr);
  }
  
  // 2. Sync Habits & Write Values
  // Get Live Data
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const liveData = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // [Name, Period]
  
  // Get History Rows
  const hLastRow = Math.max(1, historySheet.getLastRow());
  const hData = historySheet.getRange(1, 1, hLastRow, 1).getValues(); // Names only
  
  const historyMap = {}; // Name -> RowIndex (1-based)
  for (let i = 1; i < hData.length; i++) {
      historyMap[hData[i][0]] = i + 1;
  }
  
  // Write
  for (let i = 0; i < liveData.length; i++) {
      const name = liveData[i][0];
      const period = liveData[i][1] || "1/d"; // Default if empty?
      
      let hRow = historyMap[name];
      if (!hRow) {
          historySheet.appendRow([name]);
          hRow = historySheet.getLastRow();
          historyMap[name] = hRow;
      }
      
      historySheet.getRange(hRow, dateColIdx).setValue(period);
  }
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
  // Header row is Row 1. Dates start at Col 3 (Index C).
  const lastCol = sheet.getLastColumn();
  if (lastCol < 3) return -1;
  
  // Get header dates from C1...
  const headers = sheet.getRange(1, 3, 1, lastCol - 2).getValues()[0];
  
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
    if (hStr === dateStr) return i + 3; // Col index (1-based, +3 offset because dates start at C)
  }
  return -1;
}
