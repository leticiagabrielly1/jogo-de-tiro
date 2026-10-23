import math
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import (
    Flask,
    g,
    jsonify,
    render_template,
    request,
    send_from_directory,
    session,
)

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)

app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
    DATABASE=BASE_DIR / "deadzone.db",
    MAX_CONTENT_LENGTH=16 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

DIFFICULTIES = {"easy", "normal", "hard"}


def database():
    if "database" not in g:
        connection = sqlite3.connect(
            app.config["DATABASE"],
            timeout=10,
        )
        connection.row_factory = sqlite3.Row
        g.database = connection

    return g.database


@app.teardown_appcontext
def close_database(error=None):
    connection = g.pop("database", None)

    if connection is not None:
        connection.close()


def initialize_database():
    with sqlite3.connect(app.config["DATABASE"]) as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                nickname TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                wave INTEGER NOT NULL DEFAULT 1,
                kills INTEGER NOT NULL DEFAULT 0,
                headshots INTEGER NOT NULL DEFAULT 0,
                seconds REAL NOT NULL DEFAULT 0,
                finished INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS ranking_index
            ON matches (finished, difficulty, score DESC);
        """)


def json_error(message, status=400):
    return jsonify(error=message), status


def request_data():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@app.before_request
def protect_api():
    if request.path.startswith("/api/") and request.method == "POST":
        expected = session.get("csrf", "")
        received = request.headers.get("X-CSRF-Token", "")

        if not expected or not secrets.compare_digest(expected, received):
            return json_error(
                "Sua sessão expirou. Atualize a página e tente novamente.",
                403,
            )

        if not request.is_json:
            return json_error("Envie os dados em JSON.", 415)


@app.get("/")
def index():
    session.setdefault("csrf", secrets.token_hex(32))
    session.setdefault("owner", secrets.token_hex(24))

    return render_template(
        "index.html",
        bootstrap={
            "csrf": session["csrf"],
            "nickname": session.get("nickname", ""),
        },
    )


@app.get("/assets/game.js")
def game_script():
    candidates = [
        BASE_DIR / "static" / "js" / "game.js",
        BASE_DIR / "static" / "game.js",
    ]

    for path in candidates:
        if path.is_file():
            response = send_from_directory(
                str(path.parent),
                path.name,
                mimetype="application/javascript",
                max_age=0,
            )
            response.headers["Cache-Control"] = "no-store"
            return response

    return (
        "Arquivo game.js não encontrado. "
        "Coloque o código completo em static/js/game.js ou static/game.js.",
        404,
        {"Content-Type": "text/plain; charset=utf-8"},
    )


@app.post("/api/profile")
def profile():
    data = request_data()
    nickname = data.get("nickname")

    if not isinstance(nickname, str):
        return json_error("Digite seu codinome.")

    nickname = " ".join(nickname.split())

    if not 2 <= len(nickname) <= 24:
        return json_error("Use entre 2 e 24 caracteres.")

    if any(ord(character) < 32 for character in nickname):
        return json_error("Codinome inválido.")

    session["nickname"] = nickname

    return jsonify(nickname=nickname)


@app.post("/api/matches")
def start_match():
    if not session.get("nickname"):
        return json_error("Escolha seu codinome primeiro.", 401)

    data = request_data()
    difficulty = data.get("difficulty", "normal")

    if difficulty not in DIFFICULTIES:
        return json_error("Dificuldade inválida.")

    match_id = secrets.token_urlsafe(24)

    connection = database()
    connection.execute(
        """
        INSERT INTO matches (
            id,
            owner,
            nickname,
            difficulty,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            match_id,
            session["owner"],
            session["nickname"],
            difficulty,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    connection.commit()

    return jsonify(id=match_id), 201


@app.post("/api/matches/<match_id>/finish")
def finish_match(match_id):
    data = request_data()

    limits = {
        "score": (0, 1_000_000_000),
        "wave": (1, 10000),
        "kills": (0, 1_000_000),
        "headshots": (0, 1_000_000),
    }

    for field, (minimum, maximum) in limits.items():
        value = data.get(field)

        if type(value) is not int:
            return json_error(f"Valor inválido: {field}.")

        if not minimum <= value <= maximum:
            return json_error(f"Valor fora do limite: {field}.")

    seconds = data.get("seconds")

    if (
        type(seconds) not in (int, float)
        or not math.isfinite(seconds)
        or not 0 <= seconds <= 604800
    ):
        return json_error("Tempo inválido.")

    if data["headshots"] > data["kills"]:
        return json_error("Estatísticas incompatíveis.")

    connection = database()
    match = connection.execute(
        """
        SELECT *
        FROM matches
        WHERE id = ? AND owner = ?
        """,
        (match_id, session.get("owner", "")),
    ).fetchone()

    if match is None:
        return json_error("Partida não encontrada.", 404)

    if match["finished"]:
        return jsonify(saved=True)

    connection.execute(
        """
        UPDATE matches
        SET score = ?,
            wave = ?,
            kills = ?,
            headshots = ?,
            seconds = ?,
            finished = 1
        WHERE id = ?
          AND owner = ?
          AND finished = 0
        """,
        (
            data["score"],
            data["wave"],
            data["kills"],
            data["headshots"],
            seconds,
            match_id,
            session["owner"],
        ),
    )
    connection.commit()

    return jsonify(saved=True)


@app.get("/api/ranking")
def ranking():
    difficulty = request.args.get("difficulty", "normal")

    if difficulty not in DIFFICULTIES:
        return json_error("Dificuldade inválida.")

    rows = database().execute(
        """
        SELECT nickname, score, wave, kills, headshots, seconds
        FROM matches
        WHERE finished = 1 AND difficulty = ?
        ORDER BY score DESC, wave DESC, kills DESC, seconds ASC
        LIMIT 15
        """,
        (difficulty,),
    ).fetchall()

    return jsonify(ranking=[dict(row) for row in rows])


@app.errorhandler(413)
def payload_too_large(error):
    return json_error("Requisição muito grande.", 413)


initialize_database()

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
    )