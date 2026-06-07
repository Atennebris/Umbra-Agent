/// @file game.gml — Umbra demo: GML 2.3 features

// ── Base constructor ──────────────────────────────────────────────────────
function Entity(_x, _y) constructor {
    x = _x;
    y = _y;
    active = true;

    static destroy = function() {
        active = false;
        instance_destroy();
    };

    static toString = function() {
        return $"Entity({x},{y})";
    };
}

// ── Derived constructor (inheritance) ────────────────────────────────────
function Player(_x, _y) : Entity(_x, _y) constructor {
    health   = 100;
    speed    = 4;
    score    = 0;

    static move = function(_dir) {
        x += _dir * speed;
    };

    static take_damage = function(_amount) {
        health -= _amount;
        if (health <= 0) destroy();
    };

    static add_score = function(_pts) {
        score    += _pts;
        global.total_score += _pts;
    };
}

// ── Regular functions ─────────────────────────────────────────────────────
function scr_init_game() {
    global.score  = 0;
    global.level  = 1;
    global.paused = false;
}

function scr_update_hud(player) {
    draw_text(16, 16, $"HP: {player.health}  Score: {player.score}");
}

function get_high_score() {
    return global.total_score;
}

// ── Function assigned as variable ─────────────────────────────────────────
var scr_math = {
    lerp_val: function(_a, _b, _t) { return lerp(_a, _b, _t); },
    clamp_val: function(_v, _lo, _hi) { return clamp(_v, _lo, _hi); }
};

// ── Macros ────────────────────────────────────────────────────────────────
#macro SCREEN_WIDTH   1920
#macro SCREEN_HEIGHT  1080
#macro GAME_VERSION   "1.0"
#macro DEBUG_MODE     false

// ── Enums ─────────────────────────────────────────────────────────────────
enum GameState {
    Menu,
    Playing,
    Paused,
    GameOver
}

enum Direction {
    Up    = 0,
    Down  = 1,
    Left  = 2,
    Right = 3
}

// ── Global variable declarations ──────────────────────────────────────────
globalvar global_debug_mode;
globalvar global_save_data;
globalvar global_total_score;
