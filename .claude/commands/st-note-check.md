# /st-note-check — Subject Tutoring Note Check

Consolidates student progress notes for Subject Tutoring sessions. Pulls session data from Appointment-Plus, reads each student's Google Doc (grade tracker + session notes), and produces a Google Sheet and Google Doc report with flags and recommendations.

Arguments passed: `$ARGUMENTS`

---

## Step 0 — Parse Arguments

- If `$ARGUMENTS` contains two dates (any format), use them as the date range (start and end).
- If `$ARGUMENTS` contains `--csv <path>`, skip Playwright and read the CSV file directly (jump to Step 1B).
- If `$ARGUMENTS` is empty, default to the last 7 days (today minus 7 through yesterday).
- Dates must be formatted as `M/D/YYYY` for Appointment-Plus.

---

## Step 1A — Get Session Data from Appointment-Plus (Primary Path)

The A+ report interface uses a frameset. All form interactions must target the `slots` frame via JavaScript:
```
document.querySelector('frame[name="slots"]').contentDocument
```

### Navigation
1. Navigate to `https://account.appointment-plus.com/ap/ap_admin_v2/appointments_index_v2.php?p=reports`
2. If redirected to a login page (URL contains `login.php`), **stop and ask the user** to log in first, then retry.

### Run the Report
Using `browser_evaluate`, execute JavaScript on the `slots` frame:

1. **Select the saved report**: Set `select[name="report_id"]` to value `709` ("ST Note Checks") and dispatch a `change` event.
2. **Set date range**: Set `#apt_date_from` and `#apt_date_to` to the date range in `M/D/YYYY` format.
3. **Click Run Report**: Click `#run_the_report`.

### Collect Results
4. The report opens in a **new tab** titled "Site Administration - Session Report". Switch to it using `browser_tabs` (select the tab with that title).
5. Wait briefly for the page to load, then scrape the HTML table:

```javascript
const table = document.querySelector('table');
const rows = Array.from(table.querySelectorAll('tr'));
return rows.map(r => {
  const cells = Array.from(r.querySelectorAll('td, th'));
  return cells.map(c => c.textContent.trim());
});
```

### Table Columns
The report table has these columns (in order):
| Index | Column | Description |
|-------|--------|-------------|
| 0 | (checkbox) | Ignore |
| 1 | Student Name | e.g., "Apurva Sreepada" |
| 2 | Session Date | e.g., "4/3/2026" |
| 3 | Service | The specific subject, e.g., "AP Statistics", "Algebra 2", "Performance Coaching" |
| 4 | Teacher (screen name) | Tutor first name, e.g., "Addison" |
| 5 | Duration | e.g., "1 hour", "30 minutes" |
| 6 | Session Notes (internal) | Internal A+ notes |

### Post-Processing
- Skip the header row (index 0).
- **Exclude** students: Avery Arnold, Wesli Arnold (they are LC students coded as ST).
- Group sessions by student name. For each student, collect: all session dates, subjects, tutors.
- Close the report tab after scraping.

---

## Step 1B — CSV Fallback

If `--csv <path>` was provided:
1. Read the file at the given path.
2. Parse as CSV with the same columns as above: Student Name, Session Date, Service, Teacher, Duration, Session Notes.
3. Apply the same exclusions and grouping.

---

## Step 2 — Find Student Google Docs

All ST Notes docs are in **Google Drive folder** `School Subject Tutoring/ST Student Binders/` (folder ID: `1K4DQmKLiQ7x-mWPo94zYzGkOlVWZpJ8x`). Each student has a subfolder containing their notes doc.

### Bulk Search
Call `mcp__google-workspace__search` with:
- `query`: `name contains 'ST Notes' and mimeType = 'application/vnd.google-apps.document'`
- `rawQuery`: `true`
- `pageSize`: `100`

If there are more results (100+), use the `pageToken` to fetch additional pages.

### Name Matching
For each student from the A+ report, find their Google Doc by matching student name to doc title:
- Normalize: lowercase, trim whitespace.
- Match on first name + last name appearing in the doc title.
- Handle common discrepancies:
  - Doc may use full name while A+ uses nickname (e.g., "Alexandra" vs "Alex").
  - Doc title may have extra words (e.g., "Lexie Maggs Math ST Notes 2025-2026").
  - Some docs use lowercase "notes" (e.g., "ST notes" vs "ST Notes").
- If no match found, try searching specifically: `name contains '<LastName>' and name contains 'ST'`
- If still no match: flag as `NO_DOC_FOUND`.

### Filter Out Non-ST Docs
Exclude docs whose titles contain "SAT Student Notes" or "ACT Student Notes" — those are exam prep, not subject tutoring.

---

## Step 3 — Read Grade Tracker

For each matched student doc:

1. Call `listDocumentTabs` with the document ID and `includeContent: true`.
2. Find the tab whose name contains "Grade Tracker" (case-insensitive). This is typically the first tab.
3. Call `readGoogleDoc` with `documentId`, `tabId` for the Grade Tracker tab, `format: "markdown"`.

### Parse Grade Tracker
The grade tracker is a table with this structure:
- Row pattern: `Class` | `Date:` | `Date:` | `Date:` | ... (column headers)
- Then: `Subject Name` | grade | grade | grade | ... (e.g., "AP Stats" | "B" | "" | ...)
- Then: `Assignments` or `# of Missing Assignments` | count | count | ...

Extract:
- **Current grade**: the most recent non-empty grade value for the student's subject.
- **Grade history**: all grade entries with their dates, to determine trend.
- **Missing assignments count**: most recent non-empty value.
- **Trend**: Compare current to previous grades. Classify as IMPROVING, DECLINING, STABLE, or UNKNOWN (if only one data point or empty).

If the grade tracker tab is empty or has no filled-in grades, set status to `GRADE_TRACKER_EMPTY`.

---

## Step 4 — Read Session Notes

### Identify Notes Tabs
After reading the Grade Tracker, the remaining tabs contain session notes. Tab structure varies:
- Some students have a single "Notes" tab.
- Others have **subject-specific tabs** (e.g., "AP Stats - 2025", "PreCalc", "Algebra II - 2022").
- Use the **Service** (subject) from the A+ report to find the most relevant tab. Match subject names loosely (e.g., "AP Statistics" from A+ matches "AP Stats - 2025" tab).
- If no subject-specific tab matches, read the general "Notes" tab.
- If multiple subjects for one student, read multiple tabs.

### Read Notes
For each relevant tab:
- Call `readGoogleDoc` with `documentId`, `tabId`, `format: "markdown"`, `maxLength: 10000`.
- Parse individual note entries. Each entry starts with a date-tutor pattern:
  - `Date - Tutor Name` (e.g., "September 10 - Addison", "October 8, 2025 - AP Stats - Tim", "3/30 - Cameron")
  - Date formats vary widely: full month name, abbreviated, M/D, M/D/YYYY, etc.

### Cross-Reference with A+ Sessions
For each session date from the A+ report:
- Check if a matching note entry exists in the Google Doc (allow ±1 day tolerance).
- Classify each session's note status:
  - `COMPLETE`: matching note found with substantive content (20+ words).
  - `TOO_BRIEF`: note exists but is fewer than 20 words (e.g., "More homework." or "Review for test tomorrow.").
  - `MISSING`: no note entry found for that session date.

### Scan for Successes and Concerns
Scan the note text for the review period for:

**Successes** (positive signals):
- A or high score on test/quiz
- Grade increase or improvement mentioned
- "mastered", "confident", "feels good", "doing well"
- Assignment completed or turned in
- "100%", "passed"

**Concerns** (negative signals):
- Behavior: "protesting", "argumentative", "disrespectful", "distracted", "off task", "phone"
- Energy/health: "tired", "sick", "low energy"
- Academic: "grade drop", "grade slipping", "failing", "D", "F", "missing assignments", "late work", "zeros"
- Engagement: "didn't bring materials", "no homework", "unprepared"
- Tutor concern: "concerned", "worried", "struggling significantly"

Extract relevant quotes (keep them short — one sentence max).

### Check Grade Tracker Currency
If the grade tracker has not been updated in 3+ weeks (no new date columns with grades), flag as `GRADE_TRACKER_STALE`.

---

## Step 5 — Compile Per-Student Summary

For each student, compile:

| Field | Description |
|-------|-------------|
| **Name** | From A+ report |
| **Subject(s)** | Specific subject from A+ Service column |
| **Tutor(s)** | From A+ Teacher column |
| **Sessions** | Count of sessions in the date range |
| **Current Grade** | From grade tracker (letter or percentage) |
| **Grade Trend** | IMPROVING / DECLINING / STABLE / UNKNOWN |
| **Missing Assignments** | Count from grade tracker |
| **Notes Status** | "X of Y complete" or "all complete" |
| **Missing Note Dates** | List of session dates with no notes |
| **Too-Brief Notes** | List of session dates with insufficient notes |
| **Successes** | Extracted success quotes |
| **Concerns** | Extracted concern quotes |
| **Doc Link** | Link to the Google Doc |

### Severity Flags
Assign each student a flag:
- **RED**: Any of: grade declining (B to C or lower, or any drop to D/F), 2+ missing notes, behavior concern noted, or grade tracker empty AND no grade mentioned in notes.
- **YELLOW**: Any of: 1 missing note, too-brief notes, grade tracker stale (3+ weeks not updated), or grade is C and not improving.
- **GREEN**: Notes complete, grade stable or improving, no concerns.

---

## Step 6 — Create Google Sheet

Create a Google Sheet titled: `ST Note Check — {startDate} to {endDate}`

### Tab 1: "Summary"
One row per student, columns:
- Student Name
- Subject
- Tutor
- Current Grade
- Grade Trend
- Sessions (count)
- Notes Complete (e.g., "3 of 4")
- Missing Note Dates
- Flags (RED/YELLOW/GREEN)
- Concerns
- Successes
- Doc Link

Sort by: RED first, then YELLOW, then GREEN. Within each group, sort alphabetically by student name.

### Tab 2: "Flagged Items"
Only RED and YELLOW students. Columns:
- Student Name
- Flag (RED/YELLOW)
- Issue(s) — specific description (e.g., "Grade dropped from B to D", "Missing notes for 3/28, 4/1", "Behavior concern: student was argumentative")
- Recommended Action — suggest what to do (e.g., "Follow up with family about grade drop", "Ask tutor Cameron to complete missing notes", "Schedule check-in with student")

### Tab 3: "Tutor Notes Status"
Group missing/brief notes by tutor name. Columns:
- Tutor Name
- Total Sessions
- Notes Complete
- Notes Missing
- Notes Too Brief
- Missing Note Details (student name + date for each)

This tab helps with tutor accountability follow-up.

---

## Step 7 — Create Google Doc

Create a Google Doc titled: `ST Note Check Report — {startDate} to {endDate}`

### Structure:

**Header**: "Subject Tutoring Note Check Report" with date range and run date.

**Executive Summary** (2-3 sentences):
- Total students checked, total sessions in period
- Notes completion rate (X% complete)
- Number of RED/YELLOW/GREEN students
- Top concern areas

**RED Flag Students** (detailed section):
For each RED student:
- Name, subject, tutor, current grade, trend
- Specific issues with quotes from notes
- Recommended actions for center manager

**YELLOW Flag Students** (moderate detail):
For each YELLOW student:
- Name, subject, tutor, current grade
- Issues (missing notes, stale tracker, etc.)

**GREEN Flag Students** (brief):
- Bulleted list: Name — Subject — Grade — brief positive note if any

**Tutor Accountability**:
- Table of tutors with missing/brief note counts
- Specific follow-up items (which students, which dates)

**Recommendations**:
- Summarize top 3-5 action items for the center manager based on the data

---

## Error Handling

- If A+ is not logged in (redirect to login.php), stop and ask the user to log in.
- If A+ report returns no rows, inform the user that no ST sessions were found in the date range.
- If a student's Google Doc cannot be found, include them in the report with `NO_DOC_FOUND` status and list in Flagged Items.
- If a Google Doc tab cannot be read (permission error, etc.), note the error and continue with other students.
- If Google Sheet or Doc creation fails, fall back to outputting the report as formatted text in the conversation.

---

## Important Notes

- Process students **sequentially** to avoid overwhelming the Google API. Brief pause between students if processing more than 15.
- Keep `maxLength: 10000` on all `readGoogleDoc` calls to prevent context overload.
- The grade tracker format varies — some use the standard template (Period 1-7 rows), others use a simplified version (just subject + dates). Be flexible in parsing.
- Some students have multiple subjects. Treat each subject as a separate line item in the report.
- "Performance Coaching" sessions in the A+ report are part of ST and should be included unless they clearly don't have a corresponding notes doc.
