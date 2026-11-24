# CleanTrack — Waste Issue Reporting & Resolution Platform

A full-stack hackathon prototype with a Python Flask backend, SQLite database, and HTML/CSS/JavaScript frontend. It demonstrates the end-to-end workflow between residents, municipal administrators, and sanitation field teams.

> **Technology interpretation:** This project uses JavaScript in the browser. The backend is Python/Flask. It does not use a Java (JVM) backend.

## Features included

### Resident workspace
- Resident demo login
- Submit a waste complaint with category, description, neighbourhood, optional landmark and optional image
- Select the issue location by clicking on a Leaflet map or using browser geolocation
- Automatically generated complaint reference
- View personal reports and full status history
- Provide additional information when requested by an administrator
- Submit feedback after closure or request reopening

### Administrator workspace
- Complaint inbox with reference/category/area search and status/category filters
- Review, accept, request information or reject a complaint with a reason
- Set complaint priority
- View possible nearby same-category reports and link duplicates
- Assign or reassign work to field-team users
- View completion evidence, verify resolution or return work for rework
- Geographic issue map
- Operational dashboard: status counts, category distribution, overdue count, reopening count, average closure time and team workload
- In-app notifications and complaint audit history

### Collection-team workspace
- View tasks assigned to the logged-in team member
- Start assigned work
- Submit completion note and required after-cleanup photograph
- View task location and complaint history

## Stack

- Python 3 + Flask
- SQLite (built into Python)
- HTML5, CSS3, vanilla JavaScript
- Leaflet.js + OpenStreetMap tiles
- Browser Geolocation API

No Google Maps key, paid map API, separate database server, Node.js build process, or frontend package installation is required.

## Requirements

- Python 3.10 or newer
- Internet connection when first loading the frontend (Leaflet and map tiles are loaded from public CDN/OSM services)

## Run on Windows

1. Extract the ZIP.
2. Open the `cleantrack` folder in VS Code.
3. Open Terminal in that folder.
4. Run:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

5. Open `http://127.0.0.1:5000` in your browser.

Alternatively, double-click `run.bat` (PowerShell execution policy is not needed for the batch file).

## Run on macOS / Linux

```bash
cd cleantrack
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Then open `http://127.0.0.1:5000`.

## Demo accounts

All demo accounts use the password `demo123`.

| Role | Email | Password |
|---|---|---|
| Resident | `resident@cleantrack.demo` | `demo123` |
| Administrator | `admin@cleantrack.demo` | `demo123` |
| Field team 1 | `worker@cleantrack.demo` | `demo123` |
| Field team 2 | `worker2@cleantrack.demo` | `demo123` |

The database is seeded with fictional demonstration complaints and will be created automatically on first launch. To reset all demo data, stop the server, delete `cleantrack.db`, delete the files inside `uploads/`, and start the server again.

## Suggested demonstration sequence

1. Sign in as the resident and create a new complaint. Select a map point and optionally upload a photo.
2. Sign out and sign in as the administrator.
3. Open the new complaint, start review, accept it, set its priority and assign a field-team member.
4. Sign out and sign in as the assigned field-team member.
5. Open the assigned task, start work, then submit an after-cleaning image and completion note.
6. Sign in as administrator and verify the completion evidence, or return the task for rework.
7. Sign back in as the resident and inspect the status history. After closure, submit feedback or request reopening.

## Important prototype limitations

- The demo logins are seeded accounts, not a full public registration or password-reset system.
- Notifications are in-app only; email and SMS are not configured.
- Possible duplicate detection is a same-category, approximate 250-metre proximity hint. An administrator makes the final decision.
- A 48-hour overdue threshold is used in the demo dashboard; it is not an official municipal service-level agreement.
- Map issue hotspots represent submitted reports, not independently verified waste measurements.
- Images are saved locally in `uploads/`; persistent production deployments need durable object storage and backups.
- The default Flask secret is for local development only. Set `CLEANTRACK_SECRET` to a strong random value before exposing the app to others. Use HTTPS, `COOKIE_SECURE=1`, proper account management, rate limiting, stricter upload validation/scanning, database backups and a production WSGI server before any real deployment.
- The OpenStreetMap public tile service is community infrastructure with a usage policy and no uptime guarantee. Respect attribution and tile usage requirements; do not use the public tile endpoint for heavy production traffic.
- Browser geolocation requires user permission and a secure context (localhost is allowed for development). Manual map selection is available as a fallback.

## Project structure

```text
cleantrack/
├── app.py                  # Flask routes, business rules and SQLite schema
├── requirements.txt
├── README.md
├── run.bat
├── .env.example
├── templates/
│   └── index.html          # Single-page application shell
├── static/
│   ├── app.js              # Frontend views, API calls and map interactions
│   └── style.css           # Responsive application styling
└── uploads/                # Uploaded report and completion photos
```

## Main complaint lifecycle

`Submitted → Under Review → Accepted → Assigned → In Progress → Resolved – Pending Verification → Closed`

Alternative paths include `Needs Information`, `Rejected`, `Duplicate`, and `Reopened`. The administrator verifies completion evidence before closure.
