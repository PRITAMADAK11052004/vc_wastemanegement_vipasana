from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, session, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "cleantrack.db"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

CATEGORIES = [
    "Overflowing bin",
    "Roadside litter",
    "Illegal dumping",
    "Plastic waste",
    "Electronic waste",
    "Construction debris",
    "Organic waste",
    "Other",
]
STATUSES = [
    "Submitted", "Under Review", "Needs Information", "Accepted", "Assigned",
    "In Progress", "Resolved – Pending Verification", "Closed", "Rejected",
    "Duplicate", "Reopened",
]
PRIORITIES = ["Low", "Medium", "High", "Critical"]
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("CLEANTRACK_SECRET", "change-this-secret-before-deployment"),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    JSON_SORT_KEYS=False,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def init_db() -> None:
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('resident','admin','worker')),
                area TEXT DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS complaints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_id TEXT NOT NULL UNIQUE,
                resident_id INTEGER NOT NULL REFERENCES users(id),
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                area TEXT NOT NULL,
                address TEXT DEFAULT '',
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                priority TEXT NOT NULL DEFAULT 'Medium',
                status TEXT NOT NULL DEFAULT 'Submitted',
                assigned_to INTEGER REFERENCES users(id),
                duplicate_of INTEGER REFERENCES complaints(id),
                image_before TEXT,
                image_after TEXT,
                completion_note TEXT DEFAULT '',
                rejection_reason TEXT DEFAULT '',
                feedback_rating INTEGER,
                feedback_comment TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                resolved_at TEXT,
                closed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS complaint_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
                actor_id INTEGER REFERENCES users(id),
                from_status TEXT,
                to_status TEXT,
                action TEXT NOT NULL,
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
            CREATE INDEX IF NOT EXISTS idx_complaints_resident ON complaints(resident_id);
            CREATE INDEX IF NOT EXISTS idx_complaints_assigned ON complaints(assigned_to);
            CREATE INDEX IF NOT EXISTS idx_events_complaint ON complaint_events(complaint_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
            """
        )
        # Demo accounts. These are for a hackathon prototype only.
        demo_users = [
            ("Aarav Resident", "resident@cleantrack.demo", "resident", "Lake Town"),
            ("CleanTrack Admin", "admin@cleantrack.demo", "admin", "Kolkata"),
            ("Ravi Das · Field Team", "worker@cleantrack.demo", "worker", "Lake Town"),
            ("Mita Roy · Field Team", "worker2@cleantrack.demo", "worker", "Dum Dum"),
        ]
        for name, email, role, area in demo_users:
            existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            if not existing:
                db.execute(
                    "INSERT INTO users(name,email,password_hash,role,area,created_at) VALUES(?,?,?,?,?,?)",
                    (name, email, generate_password_hash("demo123"), role, area, utc_now()),
                )
        db.commit()

        count = db.execute("SELECT COUNT(*) AS n FROM complaints").fetchone()["n"]
        if count == 0:
            resident_id = db.execute("SELECT id FROM users WHERE email='resident@cleantrack.demo'").fetchone()["id"]
            admin_id = db.execute("SELECT id FROM users WHERE email='admin@cleantrack.demo'").fetchone()["id"]
            worker_id = db.execute("SELECT id FROM users WHERE email='worker@cleantrack.demo'").fetchone()["id"]
            sample_items = [
                ("CT-DEMO-001", "Overflowing bin", "Community bin is full and waste has spilled onto the footpath.", "Lake Town", "Near Lake Town market", 22.6085, 88.4007, "High", "Submitted", None),
                ("CT-DEMO-002", "Roadside litter", "Plastic packaging and food waste are scattered along the roadside.", "Dum Dum", "Dum Dum Road, near bus stop", 22.6330, 88.4220, "Medium", "Assigned", worker_id),
                ("CT-DEMO-003", "Illegal dumping", "A large pile of mixed household waste has been dumped beside the vacant plot.", "Lake Town", "Block B community lane", 22.6150, 88.4050, "High", "In Progress", worker_id),
                ("CT-DEMO-004", "Electronic waste", "Discarded electronics have been left beside the public collection point.", "Dum Dum", "Near station approach road", 22.6220, 88.4140, "Medium", "Closed", None),
            ]
            for item in sample_items:
                (public_id, category, description, area, address, lat, lng, priority, status, assigned_to) = item
                created = (datetime.now(timezone.utc) - timedelta(hours=8 if status == "Submitted" else 30)).isoformat(timespec="seconds")
                cur = db.execute(
                    """INSERT INTO complaints(public_id,resident_id,category,description,area,address,latitude,longitude,
                       priority,status,assigned_to,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (public_id, resident_id, category, description, area, address, lat, lng, priority, status, assigned_to, created, utc_now(), utc_now() if status == "Closed" else None),
                )
                cid = cur.lastrowid
                db.execute("INSERT INTO complaint_events(complaint_id,actor_id,from_status,to_status,action,note,created_at) VALUES(?,?,?,?,?,?,?)",
                           (cid, resident_id, None, "Submitted", "Complaint submitted", "Sample demonstration report", created))
                if status != "Submitted":
                    db.execute("INSERT INTO complaint_events(complaint_id,actor_id,from_status,to_status,action,note,created_at) VALUES(?,?,?,?,?,?,?)",
                               (cid, admin_id, "Submitted", status, "Sample status update", "Seeded demonstration record", utc_now()))
            db.commit()


def create_event(db: sqlite3.Connection, complaint_id: int, actor_id: int | None,
                 old_status: str | None, new_status: str | None, action: str, note: str = "") -> None:
    db.execute(
        "INSERT INTO complaint_events(complaint_id,actor_id,from_status,to_status,action,note,created_at) VALUES(?,?,?,?,?,?,?)",
        (complaint_id, actor_id, old_status, new_status, action, note, utc_now()),
    )


def create_notification(db: sqlite3.Connection, user_id: int | None, complaint_id: int | None,
                        title: str, message: str) -> None:
    if user_id is None:
        return
    db.execute(
        "INSERT INTO notifications(user_id,complaint_id,title,message,created_at) VALUES(?,?,?,?,?)",
        (user_id, complaint_id, title, message, utc_now()),
    )


def notify_admins(db: sqlite3.Connection, complaint_id: int, title: str, message: str) -> None:
    admins = db.execute("SELECT id FROM users WHERE role='admin' AND active=1").fetchall()
    for admin in admins:
        create_notification(db, admin["id"], complaint_id, title, message)


def current_user() -> dict[str, Any] | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    with get_db() as db:
        row = db.execute("SELECT id,name,email,role,area FROM users WHERE id=? AND active=1", (user_id,)).fetchone()
        return row_dict(row)


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error="Authentication required."), 401
        request.user = user
        return fn(*args, **kwargs)
    return wrapper


def roles_required(*roles):
    def decorator(fn):
        @wraps(fn)
        @login_required
        def wrapper(*args, **kwargs):
            if request.user["role"] not in roles:
                return jsonify(error="You do not have permission to perform this action."), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator


@app.before_request
def protect_mutations():
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.path == "/api/login":
            return None
        token = request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf_token", "")
        if not expected or token != expected:
            return jsonify(error="Your session token is missing or expired. Refresh the page and try again."), 403


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/uploads/<path:filename>")
def uploaded_file(filename: str):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)


@app.get("/api/health")
def health():
    return jsonify(status="ok", product="CleanTrack", version="1.0.0-prototype")


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify(error="Email or password is incorrect."), 401
        session.clear()
        session["user_id"] = user["id"]
        session["csrf_token"] = uuid.uuid4().hex
        return jsonify(user={"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"], "area": user["area"]}, csrf_token=session["csrf_token"])


@app.post("/api/logout")
@login_required
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/session")
def api_session():
    user = current_user()
    if not user:
        return jsonify(user=None, csrf_token=None)
    if not session.get("csrf_token"):
        session["csrf_token"] = uuid.uuid4().hex
    return jsonify(user=user, csrf_token=session["csrf_token"])


def complaint_query_base() -> str:
    return """SELECT c.*, u.name AS resident_name, w.name AS worker_name
              FROM complaints c JOIN users u ON u.id=c.resident_id
              LEFT JOIN users w ON w.id=c.assigned_to"""


def can_access_complaint(user: dict[str, Any], complaint: sqlite3.Row) -> bool:
    return user["role"] == "admin" or (user["role"] == "resident" and complaint["resident_id"] == user["id"]) or (user["role"] == "worker" and complaint["assigned_to"] == user["id"])


def serialize_complaint(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["image_before_url"] = f"/uploads/{item['image_before']}" if item.get("image_before") else None
    item["image_after_url"] = f"/uploads/{item['image_after']}" if item.get("image_after") else None
    return item


def save_upload(file_storage, prefix: str) -> str | None:
    if not file_storage or not file_storage.filename:
        return None
    filename = secure_filename(file_storage.filename)
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError("Please upload a JPG, PNG or WEBP image.")
    stored_name = f"{prefix}_{uuid.uuid4().hex}.{extension}"
    file_storage.save(UPLOAD_DIR / stored_name)
    return stored_name


@app.get("/api/complaints")
@login_required
def list_complaints():
    user = request.user
    status = request.args.get("status", "").strip()
    category = request.args.get("category", "").strip()
    search = request.args.get("q", "").strip()
    params: list[Any] = []
    where: list[str] = []
    if user["role"] == "resident":
        where.append("c.resident_id=?")
        params.append(user["id"])
    elif user["role"] == "worker":
        where.append("c.assigned_to=?")
        params.append(user["id"])
    if status:
        where.append("c.status=?")
        params.append(status)
    if category:
        where.append("c.category=?")
        params.append(category)
    if search:
        like = f"%{search}%"
        where.append("(c.public_id LIKE ? OR c.description LIKE ? OR c.area LIKE ? OR c.category LIKE ?)")
        params.extend([like, like, like, like])
    sql = complaint_query_base()
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY CASE c.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, c.created_at DESC"
    with get_db() as db:
        rows = db.execute(sql, params).fetchall()
    return jsonify(complaints=[serialize_complaint(r) for r in rows])


@app.post("/api/complaints")
@roles_required("resident")
def create_complaint():
    data = request.form if request.form else (request.get_json(silent=True) or {})
    category = str(data.get("category", "")).strip()
    description = str(data.get("description", "")).strip()
    area = str(data.get("area", "")).strip()
    address = str(data.get("address", "")).strip()
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return jsonify(error="Choose a location on the map before submitting."), 400
    if category not in CATEGORIES:
        return jsonify(error="Select a valid waste category."), 400
    if len(description) < 10 or len(description) > 1200:
        return jsonify(error="Description must contain 10–1,200 characters."), 400
    if not area or len(area) > 100:
        return jsonify(error="Enter a valid neighbourhood or area."), 400
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return jsonify(error="The selected coordinates are invalid."), 400
    image_name = None
    try:
        if request.files:
            image_name = save_upload(request.files.get("image"), "report")
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    public_id = f"CT-{datetime.now(timezone.utc).strftime('%y%m')}-{uuid.uuid4().hex[:6].upper()}"
    created = utc_now()
    with get_db() as db:
        cur = db.execute(
            """INSERT INTO complaints(public_id,resident_id,category,description,area,address,latitude,longitude,
               image_before,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (public_id, request.user["id"], category, description, area, address, latitude, longitude, image_name, "Medium", "Submitted", created, created),
        )
        complaint_id = cur.lastrowid
        create_event(db, complaint_id, request.user["id"], None, "Submitted", "Complaint submitted", "Report received from resident")
        notify_admins(db, complaint_id, "New waste report", f"{public_id} has been submitted in {area}.")
        db.commit()
    return jsonify(ok=True, public_id=public_id, message="Your complaint has been submitted."), 201


@app.get("/api/complaints/<int:complaint_id>")
@login_required
def complaint_detail(complaint_id: int):
    with get_db() as db:
        row = db.execute(complaint_query_base() + " WHERE c.id=?", (complaint_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if not can_access_complaint(request.user, row):
            return jsonify(error="You cannot access this complaint."), 403
        events = db.execute(
            """SELECT e.*, u.name AS actor_name, u.role AS actor_role FROM complaint_events e
               LEFT JOIN users u ON u.id=e.actor_id WHERE e.complaint_id=? ORDER BY e.created_at ASC, e.id ASC""",
            (complaint_id,),
        ).fetchall()
    result = serialize_complaint(row)
    result["events"] = [dict(e) for e in events]
    return jsonify(complaint=result)


@app.get("/api/teams")
@roles_required("admin")
def list_teams():
    with get_db() as db:
        workers = db.execute("SELECT id,name,email,area FROM users WHERE role='worker' AND active=1 ORDER BY name").fetchall()
    return jsonify(teams=[dict(w) for w in workers])


@app.get("/api/complaints/<int:complaint_id>/similar")
@roles_required("admin")
def similar_complaints(complaint_id: int):
    with get_db() as db:
        target = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        if not target:
            return jsonify(error="Complaint not found."), 404
        rows = db.execute(
            """SELECT id,public_id,category,area,status,latitude,longitude,created_at FROM complaints
               WHERE id<>? AND category=? AND status NOT IN ('Closed','Rejected','Duplicate') ORDER BY created_at DESC LIMIT 30""",
            (complaint_id, target["category"]),
        ).fetchall()
    matches = []
    for row in rows:
        # Approximate proximity check; suitable as a review hint, not a definitive duplicate decision.
        lat_delta = (row["latitude"] - target["latitude"]) * 111_000
        lng_delta = (row["longitude"] - target["longitude"]) * 111_000 * max(0.1, abs(__import__('math').cos(__import__('math').radians(target["latitude"]))))
        distance = (lat_delta * lat_delta + lng_delta * lng_delta) ** 0.5
        if distance <= 250:
            matches.append({**dict(row), "approx_distance_m": round(distance)})
    return jsonify(matches=matches)


@app.post("/api/complaints/<int:complaint_id>/review")
@roles_required("admin")
def review_complaint(complaint_id: int):
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    note = str(data.get("note", "")).strip()
    reason = str(data.get("reason", "")).strip()
    transitions = {"start_review": "Under Review", "accept": "Accepted", "needs_info": "Needs Information", "reject": "Rejected"}
    if action not in transitions:
        return jsonify(error="Choose start_review, accept, needs_info or reject."), 400
    if action == "reject" and len(reason) < 5:
        return jsonify(error="Provide a rejection reason of at least 5 characters."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["status"] not in {"Submitted", "Under Review", "Needs Information", "Reopened"}:
            return jsonify(error=f"A complaint in '{row['status']}' cannot be reviewed now."), 409
        new_status = transitions[action]
        db.execute("UPDATE complaints SET status=?, rejection_reason=?, updated_at=? WHERE id=?",
                   (new_status, reason if action == "reject" else "", utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], row["status"], new_status,
                     {"start_review": "Complaint review started", "accept": "Complaint accepted", "needs_info": "More information requested", "reject": "Complaint rejected"}[action], reason or note)
        create_notification(db, row["resident_id"], complaint_id, "Complaint update", f"{row['public_id']} is now {new_status}.")
        db.commit()
    return jsonify(ok=True, status=new_status)


@app.post("/api/complaints/<int:complaint_id>/duplicate")
@roles_required("admin")
def mark_duplicate(complaint_id: int):
    data = request.get_json(silent=True) or {}
    try:
        canonical_id = int(data.get("canonical_id"))
    except (TypeError, ValueError):
        return jsonify(error="Select the existing complaint this report duplicates."), 400
    note = str(data.get("note", "")).strip()
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        canonical = db.execute("SELECT * FROM complaints WHERE id=?", (canonical_id,)).fetchone()
        if not row or not canonical:
            return jsonify(error="Complaint or reference complaint not found."), 404
        if complaint_id == canonical_id:
            return jsonify(error="A complaint cannot be linked as a duplicate of itself."), 400
        if row["status"] in {"Closed", "Rejected", "Duplicate"}:
            return jsonify(error="This complaint cannot be marked as a duplicate in its current state."), 409
        if canonical["status"] in {"Rejected", "Duplicate"}:
            return jsonify(error="Choose an active or closed canonical complaint."), 409
        if row["category"] != canonical["category"]:
            return jsonify(error="Possible duplicates must have the same category."), 400
        db.execute("UPDATE complaints SET status='Duplicate',duplicate_of=?,updated_at=? WHERE id=?",
                   (canonical_id, utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], row["status"], "Duplicate", "Linked as duplicate report",
                     f"Linked to {canonical['public_id']}. {note}".strip())
        create_notification(db, row["resident_id"], complaint_id, "Report linked to an existing issue",
                            f"Your report {row['public_id']} was linked to {canonical['public_id']} as a duplicate. The original report remains the tracked case.")
        db.commit()
    return jsonify(ok=True, status="Duplicate", duplicate_of=canonical["public_id"])


@app.post("/api/complaints/<int:complaint_id>/priority")
@roles_required("admin")
def set_priority(complaint_id: int):
    data = request.get_json(silent=True) or {}
    priority = data.get("priority")
    reason = str(data.get("reason", "")).strip()
    if priority not in PRIORITIES:
        return jsonify(error="Select a valid priority."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        db.execute("UPDATE complaints SET priority=?,updated_at=? WHERE id=?", (priority, utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], row["status"], row["status"], "Priority changed", f"Priority set to {priority}. {reason}".strip())
        db.commit()
    return jsonify(ok=True, priority=priority)


@app.post("/api/complaints/<int:complaint_id>/assign")
@roles_required("admin")
def assign_complaint(complaint_id: int):
    data = request.get_json(silent=True) or {}
    try:
        worker_id = int(data.get("worker_id"))
    except (TypeError, ValueError):
        return jsonify(error="Select a collection team member."), 400
    note = str(data.get("note", "")).strip()
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        worker = db.execute("SELECT * FROM users WHERE id=? AND role='worker' AND active=1", (worker_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if not worker:
            return jsonify(error="The selected team member is unavailable."), 400
        if row["status"] not in {"Accepted", "Assigned", "Reopened", "In Progress"}:
            return jsonify(error="Accept the complaint before assigning a collection team."), 409
        old_status = row["status"]
        db.execute("UPDATE complaints SET assigned_to=?,status='Assigned',updated_at=? WHERE id=?", (worker_id, utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], old_status, "Assigned", "Collection team assigned", f"Assigned to {worker['name']}. {note}".strip())
        create_notification(db, worker_id, complaint_id, "New task assigned", f"You have been assigned {row['public_id']} in {row['area']}.")
        create_notification(db, row["resident_id"], complaint_id, "Collection team assigned", f"A collection team has been assigned to {row['public_id']}.")
        db.commit()
    return jsonify(ok=True, status="Assigned", worker=worker["name"])


@app.post("/api/complaints/<int:complaint_id>/work")
@roles_required("worker")
def update_work(complaint_id: int):
    data = request.form if request.form else (request.get_json(silent=True) or {})
    action = data.get("action")
    note = str(data.get("note", "")).strip()
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["assigned_to"] != request.user["id"]:
            return jsonify(error="This task is not assigned to you."), 403
        if action == "start":
            if row["status"] != "Assigned":
                return jsonify(error="Only an assigned task can be started."), 409
            db.execute("UPDATE complaints SET status='In Progress',updated_at=? WHERE id=?", (utc_now(), complaint_id))
            create_event(db, complaint_id, request.user["id"], "Assigned", "In Progress", "Work started", note)
            new_status = "In Progress"
        elif action == "complete":
            if row["status"] != "In Progress":
                return jsonify(error="Start the task before marking it complete."), 409
            try:
                after_image = save_upload(request.files.get("after_image"), "after") if request.files else None
            except ValueError as exc:
                return jsonify(error=str(exc)), 400
            if not after_image:
                return jsonify(error="Upload an after-cleaning photograph as completion evidence."), 400
            if len(note) < 5:
                return jsonify(error="Add a short completion note (at least 5 characters)."), 400
            db.execute("UPDATE complaints SET status='Resolved – Pending Verification',image_after=?,completion_note=?,resolved_at=?,updated_at=? WHERE id=?",
                       (after_image, note, utc_now(), utc_now(), complaint_id))
            create_event(db, complaint_id, request.user["id"], "In Progress", "Resolved – Pending Verification", "Work marked completed", note)
            notify_admins(db, complaint_id, "Work ready for verification", f"{row['public_id']} has been completed by the collection team.")
            new_status = "Resolved – Pending Verification"
        else:
            return jsonify(error="Choose start or complete."), 400
        create_notification(db, row["resident_id"], complaint_id, "Complaint progress updated", f"{row['public_id']} is now {new_status}.")
        db.commit()
    return jsonify(ok=True, status=new_status)


@app.post("/api/complaints/<int:complaint_id>/verify")
@roles_required("admin")
def verify_complaint(complaint_id: int):
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    note = str(data.get("note", "")).strip()
    if action not in {"verify", "return"}:
        return jsonify(error="Choose verify or return."), 400
    if action == "return" and len(note) < 5:
        return jsonify(error="Explain why the task is being returned."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=?", (complaint_id,)).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["status"] != "Resolved – Pending Verification":
            return jsonify(error="This complaint is not waiting for verification."), 409
        if action == "verify":
            new_status = "Closed"
            db.execute("UPDATE complaints SET status=?,closed_at=?,updated_at=? WHERE id=?", (new_status, utc_now(), utc_now(), complaint_id))
            create_event(db, complaint_id, request.user["id"], row["status"], new_status, "Resolution verified", note or "Completion evidence reviewed and accepted")
            create_notification(db, row["resident_id"], complaint_id, "Issue resolved", f"Your complaint {row['public_id']} has been verified and closed.")
        else:
            new_status = "In Progress"
            db.execute("UPDATE complaints SET status=?,updated_at=? WHERE id=?", (new_status, utc_now(), complaint_id))
            create_event(db, complaint_id, request.user["id"], row["status"], new_status, "Work returned for rework", note)
            create_notification(db, row["assigned_to"], complaint_id, "Further work required", f"{row['public_id']} was returned: {note}")
            create_notification(db, row["resident_id"], complaint_id, "Resolution needs more work", f"The team has been asked to revisit {row['public_id']}.")
        db.commit()
    return jsonify(ok=True, status=new_status)


@app.post("/api/complaints/<int:complaint_id>/information")
@roles_required("resident")
def provide_information(complaint_id: int):
    data = request.get_json(silent=True) or {}
    note = str(data.get("note", "")).strip()
    if len(note) < 5:
        return jsonify(error="Provide at least 5 characters of additional information."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=? AND resident_id=?", (complaint_id, request.user["id"])).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["status"] != "Needs Information":
            return jsonify(error="This complaint is not waiting for additional information."), 409
        db.execute("UPDATE complaints SET status='Under Review',updated_at=? WHERE id=?", (utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], "Needs Information", "Under Review", "Resident provided additional information", note)
        notify_admins(db, complaint_id, "Additional information received", f"The resident has provided more information for {row['public_id']}.")
        db.commit()
    return jsonify(ok=True, status="Under Review")


@app.post("/api/complaints/<int:complaint_id>/reopen")
@roles_required("resident")
def reopen_complaint(complaint_id: int):
    data = request.get_json(silent=True) or {}
    note = str(data.get("note", "")).strip()
    if len(note) < 5:
        return jsonify(error="Explain why the issue needs another inspection."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=? AND resident_id=?", (complaint_id, request.user["id"])).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["status"] != "Closed":
            return jsonify(error="Only a closed complaint can be reopened."), 409
        db.execute("UPDATE complaints SET status='Reopened',closed_at=NULL,updated_at=? WHERE id=?", (utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], "Closed", "Reopened", "Resident requested reopening", note)
        notify_admins(db, complaint_id, "Complaint reopened", f"{row['public_id']} has been reopened by the resident.")
        db.commit()
    return jsonify(ok=True, status="Reopened")


@app.post("/api/complaints/<int:complaint_id>/feedback")
@roles_required("resident")
def submit_feedback(complaint_id: int):
    data = request.get_json(silent=True) or {}
    try:
        rating = int(data.get("rating"))
    except (TypeError, ValueError):
        return jsonify(error="Choose a rating from 1 to 5."), 400
    comment = str(data.get("comment", "")).strip()
    if rating < 1 or rating > 5:
        return jsonify(error="Rating must be between 1 and 5."), 400
    with get_db() as db:
        row = db.execute("SELECT * FROM complaints WHERE id=? AND resident_id=?", (complaint_id, request.user["id"])).fetchone()
        if not row:
            return jsonify(error="Complaint not found."), 404
        if row["status"] != "Closed":
            return jsonify(error="Feedback is available after the complaint is closed."), 409
        db.execute("UPDATE complaints SET feedback_rating=?,feedback_comment=?,updated_at=? WHERE id=?", (rating, comment, utc_now(), complaint_id))
        create_event(db, complaint_id, request.user["id"], "Closed", "Closed", "Resident feedback submitted", f"Rating: {rating}/5. {comment}")
        db.commit()
    return jsonify(ok=True)


@app.get("/api/dashboard")
@roles_required("admin")
def dashboard():
    with get_db() as db:
        counts = {row["status"]: row["n"] for row in db.execute("SELECT status,COUNT(*) AS n FROM complaints GROUP BY status").fetchall()}
        total = db.execute("SELECT COUNT(*) AS n FROM complaints").fetchone()["n"]
        closed = counts.get("Closed", 0)
        avg = db.execute("""SELECT AVG((julianday(closed_at)-julianday(created_at))*24) AS hours
                           FROM complaints WHERE closed_at IS NOT NULL""").fetchone()["hours"]
        categories = db.execute("SELECT category,COUNT(*) AS count FROM complaints GROUP BY category ORDER BY count DESC LIMIT 6").fetchall()
        areas = db.execute("SELECT area,COUNT(*) AS count FROM complaints GROUP BY area ORDER BY count DESC LIMIT 6").fetchall()
        workload = db.execute("""SELECT u.name,COUNT(c.id) AS active_tasks FROM users u
                              LEFT JOIN complaints c ON c.assigned_to=u.id AND c.status NOT IN ('Closed','Rejected','Duplicate')
                              WHERE u.role='worker' AND u.active=1 GROUP BY u.id ORDER BY active_tasks DESC""").fetchall()
        overdue = db.execute("""SELECT COUNT(*) AS n FROM complaints WHERE status NOT IN ('Closed','Rejected','Duplicate')
                             AND julianday('now')-julianday(created_at) > 2""").fetchone()["n"]
        reopened = counts.get("Reopened", 0)
    return jsonify(
        total=total,
        submitted=counts.get("Submitted", 0) + counts.get("Under Review", 0) + counts.get("Needs Information", 0),
        in_progress=counts.get("Assigned", 0) + counts.get("In Progress", 0) + counts.get("Resolved – Pending Verification", 0),
        closed=closed,
        resolution_rate=round((closed / total) * 100, 1) if total else 0,
        average_resolution_hours=round(avg, 1) if avg is not None else None,
        overdue=overdue,
        reopened=reopened,
        by_status=counts,
        by_category=[dict(r) for r in categories],
        by_area=[dict(r) for r in areas],
        team_workload=[dict(r) for r in workload],
    )


@app.get("/api/notifications")
@login_required
def get_notifications():
    with get_db() as db:
        rows = db.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30", (request.user["id"],)).fetchall()
    return jsonify(notifications=[dict(r) for r in rows])


@app.post("/api/notifications/read")
@login_required
def mark_notifications_read():
    with get_db() as db:
        db.execute("UPDATE notifications SET is_read=1 WHERE user_id=?", (request.user["id"],))
        db.commit()
    return jsonify(ok=True)


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="Image is too large. Maximum upload size is 8 MB."), 413


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify(error="Endpoint not found."), 404
    return "Page not found", 404


@app.errorhandler(500)
def server_error(_error):
    return jsonify(error="An unexpected server error occurred."), 500


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG", "0") == "1")
