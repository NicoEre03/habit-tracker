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
        toggle.addEventListener('change', (e) => {
            this.isEditorMode = e.target.checked;
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

        // Extract Dates (skip first col which is null/habit header placeholder)
        this.state.dates = rawData[0].slice(1);

        this.state.data = rawData.slice(1).map(row => {
            return {
                name: row[0],
                cells: row.slice(1) // Array of {val, note} objects
            };
        });

        this.state.habits = this.state.data.map(h => h.name);
    }

    render() {
        this.gridContainer.innerHTML = '';

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

        // --- 1. Calculate Month Spans ---
        const monthSpans = [];
        let currentMonth = null;
        let currentSpan = 0;

        renderDates.forEach((dateStr, index) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            const dObj = new Date(y, m - 1, d);
            const mStr = dObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

            if (mStr !== currentMonth) {
                if (currentMonth) {
                    monthSpans.push({ name: currentMonth, span: currentSpan });
                }
                currentMonth = mStr;
                currentSpan = 1;
            } else {
                currentSpan++;
            }
        });
        if (currentMonth) {
            monthSpans.push({ name: currentMonth, span: currentSpan });
        }

        // --- 2. Setup CSS Grid Template ---
        // Template: [Habit 120px] [Prev 30px] [Dates...] [Next 30px]
        const colTemplate = `120px 30px repeat(${renderDates.length}, 44px) 30px`;
        this.gridContainer.style.gridTemplateColumns = colTemplate;
        this.gridContainer.style.gap = "0px";

        // --- 3. Render Header Rows ---

        // Row 1: Month Header
        const cornerMonth = document.createElement('div');
        cornerMonth.className = 'header-corner-month';
        this.gridContainer.appendChild(cornerMonth);

        // 1.2 Prev Spacer (Upper Layout)
        const prevSpacerM = document.createElement('div');
        this.gridContainer.appendChild(prevSpacerM);

        // 1.3 Month Cells
        monthSpans.forEach(span => {
            const mDiv = document.createElement('div');
            mDiv.className = 'cell header-month';
            mDiv.textContent = span.name;
            mDiv.style.gridColumn = `span ${span.span}`;
            this.gridContainer.appendChild(mDiv);
        });

        // 1.4 Next Spacer
        const nextSpacerM = document.createElement('div');
        this.gridContainer.appendChild(nextSpacerM);

        // Row 2: Date Header
        const cornerDate = document.createElement('div');
        cornerDate.className = 'header-corner-date';
        cornerDate.textContent = 'Habits';
        this.gridContainer.appendChild(cornerDate);

        // 2.2 Prev Spacer
        const prevSpacerD = document.createElement('div');
        this.gridContainer.appendChild(prevSpacerD);

        // 2.3 Date Cells
        renderDates.forEach(dateStr => {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'cell header-date';

            const [y, m, d] = dateStr.split('-').map(Number);
            const dObj = new Date(y, m - 1, d);
            const dayName = dObj.toLocaleDateString('en-US', { weekday: 'short' });
            const dayNum = dObj.getDate();

            dateDiv.innerHTML = `<span style="font-size:0.8em">${dayName}</span><span style="font-size:1.1em; font-weight:bold">${dayNum}</span>`;

            if (dateStr === todayStr) {
                dateDiv.classList.add('today-col');
                dateDiv.id = 'header-today';
            }

            this.gridContainer.appendChild(dateDiv);
        });

        // 2.4 Next Spacer
        const nextSpacerD = document.createElement('div');
        this.gridContainer.appendChild(nextSpacerD);

        // --- 4. Render Data Rows ---
        this.state.data.forEach((habit, rowIndex) => {
            const rowHeader = document.createElement('div');
            rowHeader.className = 'cell header-col';
            rowHeader.textContent = habit.name;

            // Editor Mode Logic
            if (this.isEditorMode) {
                rowHeader.classList.add('draggable');
                rowHeader.draggable = true;
                rowHeader.addEventListener('dragstart', (e) => this.handleDragStart(e, rowIndex));
                rowHeader.addEventListener('dragenter', (e) => e.preventDefault());
                rowHeader.addEventListener('dragover', (e) => this.handleDragOver(e, rowIndex, rowHeader));
                rowHeader.addEventListener('dragleave', (e) => this.handleDragLeave(e, rowHeader));
                rowHeader.addEventListener('drop', (e) => this.handleDrop(e, rowIndex));
            }

            rowHeader.addEventListener('dblclick', () => {
                if (!this.isEditorMode) return;
                const newName = prompt("Rename habit:", habit.name);
                if (newName) {
                    habit.name = newName;
                    rowHeader.textContent = newName;
                    this.api.renameHabit(rowIndex, newName);
                }
            });

            rowHeader.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!this.isEditorMode) return;
                if (confirm(`Delete habit "${habit.name}"?`)) {
                    this.deleteHabit(rowIndex);
                }
            });

            this.gridContainer.appendChild(rowHeader);

            // Prev Button
            const prevCell = document.createElement('div');
            prevCell.className = 'load-more-container'; // Generic class
            prevCell.innerHTML = '<span class="load-more-arrow">‹</span>';
            prevCell.title = "Load previous days";
            prevCell.addEventListener('click', () => this.loadMorePast());
            this.gridContainer.appendChild(prevCell);

            // Data Cells (Filtered Window)
            const renderCells = habit.cells.slice(startIdx, endIdx);

            renderCells.forEach((cellData, viewIndex) => {
                const originalColIndex = startIdx + viewIndex;
                const cell = document.createElement('div');
                cell.className = `cell status-${cellData.val}`;
                cell.dataset.row = rowIndex;
                cell.dataset.col = originalColIndex;

                if (cellData.note) {
                    cell.classList.add('has-note');
                    cell.title = cellData.note;
                }

                cell.addEventListener('click', () => this.handleCellClick(cell, habit, originalColIndex));
                cell.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleCellContextMenu(cell, habit, originalColIndex);
                });

                this.gridContainer.appendChild(cell);
            });

            // Next Button
            const nextCell = document.createElement('div');
            nextCell.className = 'load-more-container';
            nextCell.innerHTML = '<span class="load-more-arrow">›</span>';
            nextCell.title = "Load more days";
            nextCell.addEventListener('click', () => this.loadMoreFuture());
            this.gridContainer.appendChild(nextCell);
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

        // Cycle: 0 -> 1 -> 2 -> 0
        // If Editor Mode, we might want to allow cycling OUT of Failed (-1)?
        // For now, let's allow resetting Failed to Neutral in Editor.

        let nextVal = 0;

        if (this.isEditorMode && cellData.val === -1) {
            nextVal = 0; // Reset failed to neutral
        } else {
            // Normal Cycle
            if (cellData.val === -1) return; // Should not happen if Default Mode checked above
            if (cellData.val === 0) nextVal = 1;
            else if (cellData.val === 1) nextVal = 2;
            else if (cellData.val === 2) nextVal = 0;
        }

        // Optimistic UI Update
        cellData.val = nextVal;

        // Update DOM classes
        // Use regex or list to clean old status classes just in case
        cellElement.className = `cell status-${nextVal}`;
        if (cellData.note) cellElement.classList.add('has-note'); // restore note class

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
                        const cell = this.gridContainer.querySelector(`.cell[data-row="${rowIndex}"][data-col="${colIndex}"]`);
                        if (cell) {
                            cell.className = `cell status--1`;
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
