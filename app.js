/**
 * Google Apps Script API Wrapper
 * Connects to the Deployed Web App
 */
class GAS_API {
    constructor() {
        this.url = "https://script.google.com/macros/s/AKfycbwSMyHmWx1o24ByErndZsCAUQBEFbilnBJM7Rsfm9xkM39OEdSteG5zVWAgO1fd-Ftz/exec";
    }

    async _request(action, payload = {}, method = 'POST') {
        // Show loading via DOM if possible, or leave to caller
        // Using POST for everything to avoid caching and simplify
        // Using text/plain to avoid preflight options check which GAS doesn't support
        const body = JSON.stringify({ action, ...payload });

        try {
            const response = await fetch(this.url, {
                method: 'POST',
                mode: 'cors',
                headers: {
                    'Content-Type': 'text/plain;charset=utf-8',
                },
                body: body
            });
            const data = await response.json();
            return data;
        } catch (error) {
            console.error("API Error:", error);
            alert("Sync Failed: " + error.message);
            throw error;
        }
    }

    async fetchData() {
        console.log("API: Fetching Data...");
        const response = await this._request('read');
        // Response matches the grid structure from code.gs
        return response;
    }

    async updateCell(habitName, dateStr, val) {
        console.log(`API: Update Cell -> ${habitName} [${dateStr}] = ${val}`);
        // We fire and forget for UI responsiveness, but could await
        return this._request('update', { habitName, dateStr, val: val });
    }

    // Note: Overloaded updateCell for notes? 
    // The previous mocked updateCell only took (row, col, status).
    // The new one takes (habitName, dateStr, val).
    // We should create a separate updateNote or make updateCell smarter.
    // Let's make a generic updateCellData to handle both

    async updateCellData(habitName, dateStr, updateObj) {
        // updateObj: { val: 1 } or { note: "abc" }
        console.log(`API: Update Data -> ${habitName} [${dateStr}]`, updateObj);
        return this._request('update', { habitName, dateStr, ...updateObj });
    }

    async syncStructure(habitsArray) {
        // Since we have specific Add/Delete/Rename actions, 
        // this generic sync might only be needed for reordering (Drag & Drop).
        // For Reorder, we haven't implemented a specific GAS function yet in code.gs!
        // The user code.gs supports: addHabit, deleteHabit, renameHabit.
        // It DOES NOT support reorder.
        // Drag & Drop will fail to persist reordering without a 'reorder' endpoint.
        // For now, Drag & Drop is a UI-only feature unless we implement 'reorder' in GAS.
        // Or we use 'rename' hack? No.
        console.warn("API: Structure Sync (Reorder) not fully implemented on backend yet.");
        return Promise.resolve();
    }

    async addHabit(name) {
        return this._request('addHabit', { name });
    }

    async deleteHabit(rowIndex) {
        return this._request('deleteHabit', { rowIndex });
    }

    async renameHabit(rowIndex, name) {
        return this._request('renameHabit', { rowIndex, name });
    }

    async reorderHabit(fromIndex, toIndex) {
        console.log(`API: Reorder ${fromIndex} -> ${toIndex}`);
        return this._request('reorderHabit', { fromIndex, toIndex });
    }

    async updateHabitPeriodicity(rowIndex, periodicity) {
        console.log(`API: Update Periodicity ${rowIndex} -> ${periodicity}`);
        return this._request('updateHabitPeriodicity', { rowIndex, periodicity });
    }

    async saveSnapshot() {
        console.log("API: Save Snapshot");
        return this._request('saveSnapshot', {});
    }
}

/**
 * Core Application Logic
 */
class HabitTracker {
    constructor() {
        this.api = new GAS_API();
        this.gridContainer = document.getElementById('habit-grid');
        this.state = {
            data: [], // 2D array
            dates: [], // Date strings from header
            habits: [] // Habit names from col 0
        };
        this.isEditorMode = false;

        // Drag State
        this.dragSrcIndex = null;

        // Modal Elements
        this.modal = document.getElementById('note-modal');
        this.noteInput = document.getElementById('note-input');
        this.noteMeta = document.getElementById('note-meta');
        this.btnSave = document.getElementById('note-save-btn');
        this.btnCancel = document.getElementById('note-cancel-btn');
        this.btnDelete = document.getElementById('note-delete-btn');

        this.loadingOverlay = document.getElementById('loading-overlay');

        this.activeCell = null; // { habit, date, cellData, element }
    }

    async init() {
        console.log("App: Initializing...");

        // Setup Toggle
        const toggle = document.getElementById('editor-mode-toggle');

        // Inject Snapshot Button
        // Inject Snapshot Button (Save Button)
        this.btnSnapshot = document.createElement('button');
        this.btnSnapshot.textContent = "Save";
        this.btnSnapshot.className = "save-btn";
        this.btnSnapshot.style.display = "none"; // Hidden by default

        this.btnSnapshot.onclick = () => {
            if (confirm("Save current periodicity settings as a snapshot?")) {
                this.loadingOverlay.classList.remove('fade-out');
                this.api.saveSnapshot()
                    .then(() => alert("Snapshot Saved to 'PeriodicityHistory' sheet!"))
                    .finally(() => this.loadingOverlay.classList.add('fade-out'));
            }
        };

        document.body.appendChild(this.btnSnapshot);

        toggle.addEventListener('change', (e) => {
            this.isEditorMode = e.target.checked;
            document.body.classList.toggle('editor-mode', this.isEditorMode); // Toggle class on body
            if (this.btnSnapshot) this.btnSnapshot.style.display = this.isEditorMode ? 'block' : 'none';
            this.render();
        });

        // Setup Modal Events
        this.btnCancel.addEventListener('click', () => this.closeModal());
        this.btnSave.addEventListener('click', () => this.saveNote());
        this.btnDelete.addEventListener('click', () => this.deleteNote());

        // Setup Resize Listener (Center Alignment)
        window.addEventListener('resize', () => {
            this.scrollToToday();
        });

        await this.loadData();
    }

    async loadData() {
        this.loadingOverlay.classList.remove('fade-out');
        try {
            const rawData = await this.api.fetchData();
            this.processData(rawData);
            this.processData(rawData);
            this.render();

            // Run Auto-Fail logic locally and SYNC changes
            this.applyAutoFail();

            this.scrollToToday();
        } catch (e) {
            console.error(e);
        } finally {
            this.loadingOverlay.classList.add('fade-out');
        }
    }

    processData(rawData) {
        // rawData[0] is headers
        // rawData[1+] are habits

        // Extract Dates (skip first two cols: null/habit header + Periodicity)
        this.state.dates = rawData[0].slice(2);

        this.state.data = rawData.slice(1).map(row => {
            return {
                name: row[0],
                periodicity: row[1] || "", // Capture Periodicity
                cells: row.slice(2) // Array of {val, note} objects
            };
        });

        this.state.habits = this.state.data.map(h => h.name);
    }

    render() {
        this.gridContainer.innerHTML = '';

        // 1. Create Table Structure
        const table = document.createElement('table');
        table.className = 'habit-grid';
        this.gridContainer.appendChild(table);

        const thead = document.createElement('thead');
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        table.appendChild(tbody);

        // VIEWPORT LOGIC: Render window around today or selection
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const todayStr = `${year}-${month}-${day}`;

        // Find index of today
        const todayIndex = this.state.dates.findIndex(d => d === todayStr);

        // Define Window
        if (!this.state.windowForward) this.state.windowForward = 15;
        if (!this.state.windowBack) this.state.windowBack = 7;

        let startIdx = 0;
        let endIdx = this.state.dates.length;

        if (todayIndex !== -1) {
            startIdx = Math.max(0, todayIndex - this.state.windowBack);
            endIdx = Math.min(this.state.dates.length, todayIndex + this.state.windowForward + 1);
        }

        // Subset
        const renderDates = this.state.dates.slice(startIdx, endIdx);

        // --- Calculate Month Spans ---
        const monthSpans = [];
        let currentMonth = null;
        let currentSpan = 0;

        renderDates.forEach((dateStr) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            const dObj = new Date(y, m - 1, d);
            const mStr = dObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

            if (mStr !== currentMonth) {
                if (currentMonth) monthSpans.push({ name: currentMonth, span: currentSpan });
                currentMonth = mStr;
                currentSpan = 1;
            } else {
                currentSpan++;
            }
        });
        if (currentMonth) monthSpans.push({ name: currentMonth, span: currentSpan });

        // --- 2. Render Header Rows (THEAD) ---

        // Row 1: Month Header
        const trMonth = document.createElement('tr');
        trMonth.className = 'header-month-row';
        thead.appendChild(trMonth);

        // 1.1 Header Left Corner (Span varies by mode)
        const cornerMonth = document.createElement('th');
        cornerMonth.className = 'header-corner header-corner-month';
        // Span = 1 (Habit) + (Editor ? 1 Period : 0) + 1 (PrevArrow which is in Row 2 but visually aligned? No, Month corner covers everything above dates)
        // Actually, Row 2 has: CornerDate (Habit), [Period?], PrevArrow.
        // So Month Corner should span all of them to look clean.
        // Default: Habit(1) + PrevArrow(1) = 2.
        // Editor: Habit(1) + Period(1) + PrevArrow(1) = 3.
        cornerMonth.colSpan = this.isEditorMode ? 3 : 2;
        trMonth.appendChild(cornerMonth);

        // 1.2 Month Cells
        monthSpans.forEach(span => {
            const th = document.createElement('th');
            th.textContent = span.name;
            th.colSpan = span.span;
            trMonth.appendChild(th);
        });

        // 1.3 End Spacer (Next Button)
        const endMonth = document.createElement('th');
        trMonth.appendChild(endMonth); // Spacer

        // Row 2: Date Header
        const trDate = document.createElement('tr');
        trDate.className = 'header-date-row';
        thead.appendChild(trDate);

        // 2.1 Header Left Corner 
        const cornerDate = document.createElement('th');
        cornerDate.className = 'header-corner header-corner-date';
        // Inner Div for Unified styling
        const cornerInner = document.createElement('div');
        cornerInner.className = 'header-corner-inner';
        cornerInner.textContent = 'Habits';
        cornerDate.appendChild(cornerInner);
        cornerDate.colSpan = 1;
        trDate.appendChild(cornerDate);

        // 2.1b Periodicity Header (Editor Mode Only)
        if (this.isEditorMode) {
            const periodTh = document.createElement('th');
            periodTh.className = 'header-corner header-corner-date period-col'; // Reuse corner style for sticky + period-col for width
            periodTh.style.left = '160px'; // Sticky offset (Habit Col Width)

            const periodInner = document.createElement('div');
            periodInner.className = 'header-corner-inner';
            periodInner.textContent = 'Freq';
            periodTh.appendChild(periodInner);

            trDate.appendChild(periodTh);
        }

        // 2.2 Prev Column Header (Spacer)
        const prevTh = document.createElement('th');
        prevTh.className = 'arrow-col'; // Added arrow-col
        prevTh.style.width = '30px';
        prevTh.style.zIndex = '45';
        trDate.appendChild(prevTh);

        // 2.3 Date Cells
        renderDates.forEach(dateStr => {
            const th = document.createElement('th');
            const [y, m, d] = dateStr.split('-').map(Number);
            const dObj = new Date(y, m - 1, d);

            // Custom Condensed Day Names
            const dayMap = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];
            const dayName = dayMap[dObj.getDay()];
            const dayNum = dObj.getDate();

            // Removed month-end-border logic

            // Use inner div for flex/stacking if needed, or simple HTML
            th.innerHTML = `<div class="header-date-cell"><span style="font-size:0.8em">${dayName}</span><span style="font-size:1.1em; font-weight:bold">${dayNum}</span></div>`;

            if (dateStr === todayStr) {
                th.classList.add('today-col');
                th.id = 'header-today';
            }
            trDate.appendChild(th);
        });

        // 2.4 Next Column Header
        const nextTh = document.createElement('th');
        nextTh.className = 'arrow-col'; // Added arrow-col
        nextTh.style.width = '30px';
        trDate.appendChild(nextTh);

        // --- 3. Render Data Rows (TBODY) ---
        this.state.data.forEach((habit, rowIndex) => {
            const tr = document.createElement('tr');
            tr.dataset.row = rowIndex; // For DnD
            tbody.appendChild(tr);

            // 3.1 Habit Name (Sticky Left TH/TD)
            const thName = document.createElement('th');
            thName.className = 'header-col sticky-col';
            // Inner Div for Card/Split styling
            const innerDiv = document.createElement('div');
            innerDiv.className = 'habit-name-inner';
            innerDiv.textContent = habit.name;
            thName.appendChild(innerDiv);

            // Editor Mode: DnD on the Habit Name (Handle)
            if (this.isEditorMode) {
                thName.draggable = true;
                thName.classList.add('draggable');
                thName.addEventListener('dragstart', (e) => this.handleDragStart(e, rowIndex));
                thName.addEventListener('dragenter', (e) => e.preventDefault());
                thName.addEventListener('dragover', (e) => this.handleDragOver(e, rowIndex, tr)); // visual on row? or th?
                // dragging the Th, but want to reorder the Row.
                // handleDragOver adds 'drag-over' class to target.
                // We should add it to the TR.
                thName.addEventListener('dragleave', (e) => this.handleDragLeave(e, tr));
                thName.addEventListener('drop', (e) => this.handleDrop(e, rowIndex));
            }

            // Editor Mode: Rename/Delete
            thName.addEventListener('dblclick', () => {
                if (!this.isEditorMode) return;
                const newName = prompt("Rename habit:", habit.name);
                if (newName) {
                    habit.name = newName;
                    const inner = thName.querySelector('.habit-name-inner');
                    if (inner) inner.textContent = newName;
                    this.api.renameHabit(rowIndex, newName);
                }
            });

            thName.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!this.isEditorMode) return;
                if (confirm(`Delete habit "${habit.name}"?`)) {
                    this.deleteHabit(rowIndex);
                }
            });

            tr.appendChild(thName);

            // 3.1b Periodicity Cell (Editor Mode Only)
            if (this.isEditorMode) {
                const tdPeriod = document.createElement('td');
                tdPeriod.className = 'period-col sticky-col';
                tdPeriod.style.left = '160px'; // Sticky offset
                tdPeriod.style.zIndex = '60'; // Same as habit name

                const periodDiv = document.createElement('div');
                periodDiv.className = 'period-col-inner';
                periodDiv.textContent = habit.periodicity || "-";

                // Edit Logic
                periodDiv.addEventListener('click', () => {
                    const newP = prompt("Set Periodicity (e.g. 1/d, 3/w, 2/m):", habit.periodicity);
                    if (newP !== null) {
                        habit.periodicity = newP;
                        periodDiv.textContent = newP || "-";
                        this.api.updateHabitPeriodicity(rowIndex, newP).then(() => {
                            // reload to process states, now that backend recalc is rigorous
                            this.loadData();
                            console.log("Periodicity updated & Data reloaded");
                        });
                    }
                });

                tdPeriod.appendChild(periodDiv);
                tr.appendChild(tdPeriod);
            }

            // 3.2 Prev Button (TD)
            const tdPrev = document.createElement('td');
            tdPrev.className = 'arrow-col'; // Sticky + Arrow Col

            const btnPrev = document.createElement('div');
            btnPrev.className = 'load-more-container';
            btnPrev.innerHTML = '<span class="load-more-arrow">‹</span>';
            btnPrev.addEventListener('click', () => this.loadMorePast());
            tdPrev.appendChild(btnPrev);
            tr.appendChild(tdPrev);

            // 3.3 Data Cells
            // 3.3 Data Cells
            const renderCells = habit.cells.slice(startIdx, endIdx);

            // Keep track of current window state for THIS row
            let currentWindowEndIndex = -1;

            renderCells.forEach((cellData, viewIndex) => {
                const originalColIndex = startIdx + viewIndex;
                const dateStr = this.state.dates[originalColIndex];

                const td = document.createElement('td');

                const cellDiv = document.createElement('div');
                cellDiv.className = 'cell';
                cellDiv.dataset.row = rowIndex;
                cellDiv.dataset.col = originalColIndex;

                // Periodicity Window Logic (Merged Overlay)
                if (habit.periodicity) {
                    const [y, m, d] = dateStr.split('-').map(Number);
                    const dObj = new Date(y, m - 1, d);
                    const day = dObj.getDay(); // 0=Sun...6=Sat

                    // Determine if this cell starts a new visual window or continues one
                    // We only want to place an anchor if we aren't already covered by a previous anchor's span

                    // Simple logic:
                    // 1. Check if we need to start a window (e.g. viewIndex > currentWindowEndIndex)
                    // 2. If yes, calculate how long it extends within the VISIBLE renderCells
                    // 3. Set anchor and span

                    if (viewIndex > currentWindowEndIndex) {
                        let span = 0;

                        // Calculate Span logic based on periodicity type
                        if (habit.periodicity.includes('/w')) {
                            // Weekly: Run until Sunday OR end of view
                            // Current day is dObj

                            // Find distance to next Sunday (0)
                            // today is day. Sunday is 0. 
                            // If today is 1 (Mon), days left = 7 (Mon..Sun). (1..0)
                            // If today is 0 (Sun), days left = 1.

                            // Let's iterate forward in renderCells to see how long this week lasts
                            // Stop if we hit a Sunday or run out of cells

                            let k = viewIndex;
                            while (k < renderCells.length) {
                                span++;
                                const kDateStr = this.state.dates[startIdx + k];
                                const kD = new Date(kDateStr);
                                // JS Date parsing from YYYY-MM-DD string treats as UTC usually, 
                                // but we instantiated with y, m-1, d above which is local.
                                // Let's stick to simple day index if possible or ensuring consistency.
                                // simpler: re-parse local
                                const [ky, km, kd] = kDateStr.split('-').map(Number);
                                const kObj = new Date(ky, km - 1, kd);

                                if (kObj.getDay() === 0) break; // End of week (Sunday)
                                k++;
                            }
                        } else if (habit.periodicity.includes('/m')) {
                            // Monthly: Run until different month
                            let k = viewIndex;
                            const startMonth = m; // 'm' is from dateStr.split at top of loop

                            while (k < renderCells.length) {
                                span++;
                                const kDateStr = this.state.dates[startIdx + k];
                                const [ky, km, kd] = kDateStr.split('-').map(Number);

                                // Check next cell (lookahead) to see if we should stop AFTER this one? 
                                // No, loop runs for current cell 'k'. 
                                // We want to include 'k' if it matches month.
                                // If 'k' logic above incremented span, we good.
                                // Wait, the loop condition needs to break if NEXT is bad? 
                                // actually, simpler:
                                // Is THIS cell valid? Yes. Span++.
                                // Is NEXT cell valid?

                                // Let's peek next to decide if we stop?
                                // Or check current k. 
                                // The loop enters with k=viewIndex. 
                                // We already inc span. 
                                // check k's month. If k's month != start, we shouldn't have entered? 
                                // No, viewIndex is valid start.

                                // Correct logic: 
                                // 1. Inc span for current k.
                                // 2. Check k+1. If k+1 is diff month, break.

                                if (startIdx + k + 1 >= this.state.dates.length) break; // End of data
                                if (k + 1 >= renderCells.length) break; // End of view

                                const nextDateStr = this.state.dates[startIdx + k + 1];
                                const [ny, nm, nd] = nextDateStr.split('-').map(Number);

                                if (nm !== startMonth) break;

                                k++;
                            }
                        } else if (habit.periodicity.includes('/d')) {
                            span = 1;
                        }

                        // Apply Anchor if span > 0
                        if (span > 0) {
                            cellDiv.classList.add('period-anchor');
                            cellDiv.style.setProperty('--span', span);
                            currentWindowEndIndex = viewIndex + span - 1;
                        }
                    }
                }

                // Inner Status Indicator
                const statusDiv = document.createElement('div');
                statusDiv.className = `status-indicator status-${cellData.val}`;
                cellDiv.appendChild(statusDiv);

                if (cellData.note) {
                    cellDiv.classList.add('has-note');
                    cellDiv.title = cellData.note;
                }

                cellDiv.addEventListener('click', () => this.handleCellClick(cellDiv, habit, originalColIndex));
                cellDiv.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleCellContextMenu(cellDiv, habit, originalColIndex);
                });

                td.appendChild(cellDiv);
                tr.appendChild(td);
            });

            // 3.4 Next Button
            const tdNext = document.createElement('td');
            tdNext.className = 'arrow-col'; // Arrow Col
            const btnNext = document.createElement('div');
            btnNext.className = 'load-more-container';
            btnNext.innerHTML = '<span class="load-more-arrow">›</span>';
            btnNext.addEventListener('click', () => this.loadMoreFuture());
            tdNext.appendChild(btnNext);
            tr.appendChild(tdNext);
        });
    }

    loadMorePast() {
        if (!this.state.windowBack) this.state.windowBack = 7;
        this.state.windowBack += 7;
        this.render();
    }

    loadMoreFuture() {
        if (!this.state.windowForward) this.state.windowForward = 15;
        this.state.windowForward += 7;
        this.render();
    }

    handleCellClick(cellElement, habitObj, colIndex) {
        const cellData = habitObj.cells[colIndex];
        const dateStr = this.state.dates[colIndex];

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const isPast = dateStr < todayStr;

        // Default Mode Restrictions
        if (!this.isEditorMode) {
            // Cannot change failed (-1)
            if (cellData.val === -1) return;

            // Cannot edit Past dates in Default Mode (implied by "Log habits for current and future")
            // "Default: Allows the user to log habits for the current and future dates."
            if (isPast) return;
        }

        // Cycle Logic
        let nextVal = 0;

        if (this.isEditorMode) {
            // Editor Mode: 0 -> 1 -> 2 -> -1 -> 0
            if (cellData.val === 0) nextVal = 1;
            else if (cellData.val === 1) nextVal = 2;
            else if (cellData.val === 2) nextVal = -1;
            else if (cellData.val === -1) nextVal = 0;
        } else {
            // Normal Mode: 0 -> 1 -> 2 -> 0 (Cannot set to -1 manually, only auto-fail)
            if (cellData.val === -1) return;
            if (cellData.val === 0) nextVal = 1;
            else if (cellData.val === 1) nextVal = 2;
            else if (cellData.val === 2) nextVal = 0;
        }

        // Optimistic UI Update
        cellData.val = nextVal;

        // Update DOM classes (Target inner indicator)
        const statusInd = cellElement.querySelector('.status-indicator');
        if (statusInd) {
            statusInd.className = `status-indicator status-${nextVal}`;
        }

        if (cellData.note) cellElement.classList.add('has-note'); // restored note class on outer cell

        // Send to API
        this.api.updateCellData(habitObj.name, this.state.dates[colIndex], { val: nextVal });
    }

    async applyAutoFail() {
        // Use Local Time for "Today"
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        console.log(`Auto-Fail Check for date < ${todayStr}`);

        // Track updates to batch or log
        let updates = [];

        this.state.data.forEach((habit, rowIndex) => {
            habit.cells.forEach((cellData, colIndex) => {
                const dateStr = this.state.dates[colIndex];

                // Check if date is strictly before today
                if (dateStr < todayStr) {
                    // If Empty (0), mark as Failed (-1)
                    if (cellData.val === 0) {
                        cellData.val = -1;

                        // Update DOM visibly
                        // Update DOM visibly
                        const cell = this.gridContainer.querySelector(`.cell[data-row="${rowIndex}"][data-col="${colIndex}"]`);
                        if (cell) {
                            const statusInd = cell.querySelector('.status-indicator');
                            if (statusInd) statusInd.className = `status-indicator status--1`;
                        }

                        // Queue update
                        updates.push({ habitName: habit.name, dateStr, val: -1 });
                    }
                }
            });
        });

        if (updates.length > 0) {
            console.log(`Auto-Fail: Found ${updates.length} failed habits. Syncing...`);
            // Sync all changes. 
            // Ideally we'd have a batch endpoint, but concurrent requests work for small numbers.
            // Be careful of rate limits.
            for (const up of updates) {
                // Fire and forget individually for now
                this.api.updateCellData(up.habitName, up.dateStr, { val: -1 });
                // Small delay to be nice to GAS?
                // await new Promise(r => setTimeout(r, 50));
            }
        }
    }

    scrollToToday() {
        // Use setTimeout to allow render paint to finish
        setTimeout(() => {
            const todayHeader = document.getElementById('header-today');
            if (todayHeader) {
                todayHeader.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        }, 100);
    }

    addHabit() {
        const name = prompt("Enter new habit name:");
        if (name) {
            this.loadingOverlay.classList.remove('fade-out');
            this.api.addHabit(name).then(() => {
                return this.loadData();
            });
        }
    }

    deleteHabit(index) {
        this.loadingOverlay.classList.remove('fade-out');
        this.api.deleteHabit(index).then(() => {
            return this.loadData();
        });
    }

    /* --- Drag and Drop Logic --- */

    handleDragStart(e, index) {
        this.dragSrcIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        // Add class for styling
        e.target.classList.add('dragging');
    }

    handleDragOver(e, index, targetElem) {
        if (e.preventDefault) {
            e.preventDefault(); // Necessary. Allows us to drop.
        }
        e.dataTransfer.dropEffect = 'move';

        // Visual cue
        if (this.dragSrcIndex !== index) {
            targetElem.classList.add('drag-over');
        }
        return false;
    }

    handleDragLeave(e, targetElem) {
        targetElem.classList.remove('drag-over');
    }

    handleDrop(e, index) {
        e.stopPropagation(); // stops the browser from redirecting.

        const dragIdx = this.dragSrcIndex;
        const dropIdx = index;

        if (dragIdx !== dropIdx) {
            // Reorder Data
            const rowToMove = this.state.data[dragIdx];
            this.state.data.splice(dragIdx, 1); // remove
            this.state.data.splice(dropIdx, 0, rowToMove); // insert

            // Reorder Habits List
            this.state.habits = this.state.data.map(h => h.name);

            // Reorder Habits List
            this.state.habits = this.state.data.map(h => h.name);

            // Sync
            // this.api.syncStructure(this.state.habits);

            // Real Sync Reorder
            this.loadingOverlay.classList.remove('fade-out');
            this.api.reorderHabit(dragIdx, dropIdx)
                .then(() => {
                    console.log("Reorder synced");
                })
                .catch(err => {
                    console.error("Reorder failed", err);
                    alert("Reorder sync failed.");
                })
                .finally(() => {
                    this.loadingOverlay.classList.add('fade-out');
                });

            // Re-render
            this.render();
        }

        return false;
    }

    /* --- Note Modal Logic --- */

    handleCellContextMenu(cellElement, habitObj, colIndex) {
        const cellData = habitObj.cells[colIndex];
        const dateStr = this.state.dates[colIndex];

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const isPast = dateStr < todayStr;

        // Check Permissions
        let canEdit = true;
        if (!this.isEditorMode) {
            // Default Mode: Can only edit Today/Future
            if (isPast) canEdit = false;
        }

        // Open Modal
        this.openModal(cellData, habitObj.name, dateStr, canEdit, cellElement);
    }

    openModal(cellData, habitName, dateStr, canEdit, cellElement) {
        this.activeCell = { cellData, cellElement, habitName, dateStr };

        this.noteInput.value = cellData.note || '';
        this.noteMeta.textContent = `${habitName} • ${dateStr}`;

        // UI Logic based on permissions
        if (canEdit) {
            this.noteInput.disabled = false;
            this.btnSave.style.display = 'block';

            // Delete button: Show if note exists AND we can edit
            if (cellData.note) {
                this.btnDelete.style.display = 'block';
            } else {
                this.btnDelete.style.display = 'none';
            }
        } else {
            // Read Only View
            this.noteInput.disabled = true;
            this.btnSave.style.display = 'none';
            this.btnDelete.style.display = 'none';
        }

        this.modal.classList.remove('hidden');
        if (canEdit) this.noteInput.focus();
    }

    closeModal() {
        this.modal.classList.add('hidden');
        this.activeCell = null;
    }

    saveNote() {
        if (!this.activeCell) return;

        const text = this.noteInput.value.trim();
        const { cellData, cellElement, habitName, dateStr } = this.activeCell; // Fixed access

        // Update Internal State
        cellData.note = text || null; // Store null if empty

        // Sim Update API (Mock)
        console.log(`Note Saved for ${habitName} on ${dateStr}: ${text}`);
        this.api.updateCellData(habitName, dateStr, { note: cellData.note || "" });

        // Update UI
        if (cellData.note) {
            cellElement.classList.add('has-note');
            cellElement.title = cellData.note;
        } else {
            cellElement.classList.remove('has-note');
            cellElement.title = '';
        }

        this.closeModal();
    }

    deleteNote() {
        if (!this.activeCell) return;
        // Just clear the input and save logic triggers
        this.noteInput.value = '';
        this.saveNote();
    }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
    const app = new HabitTracker();
    app.init();

    // Bind Add Button
    document.getElementById('add-habit-btn').addEventListener('click', () => {
        app.addHabit();
    });
});
