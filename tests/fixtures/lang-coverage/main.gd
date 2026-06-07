extends CharacterBody2D

class_name UmbraPlayer

# Player configuration constants
const MAX_SPEED := 400.0
const JUMP_FORCE := -600.0
const GRAVITY := 980.0

# Exported properties
@export var health: int = 100
@export var speed: float = MAX_SPEED
@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D

# Signals
signal player_died(player_id: int)
signal score_changed(new_score: int)
signal level_completed

enum State { IDLE, RUNNING, JUMPING, FALLING, DEAD }

var current_state: State = State.IDLE
var score: int = 0

class Inventory:
	var items: Array = []
	func add_item(item: String) -> void:
		items.append(item)

func _ready() -> void:
	set_physics_process(true)

func _physics_process(delta: float) -> void:
	_apply_gravity(delta)
	_handle_input()
	move_and_slide()

func _apply_gravity(delta: float) -> void:
	if not is_on_floor():
		velocity.y += GRAVITY * delta

func _handle_input() -> void:
	var direction := Input.get_axis("move_left", "move_right")
	velocity.x = direction * speed

func jump() -> void:
	if is_on_floor():
		velocity.y = JUMP_FORCE
		current_state = State.JUMPING

func take_damage(amount: int) -> void:
	health -= amount
	if health <= 0:
		die()

func die() -> void:
	current_state = State.DEAD
	emit_signal("player_died", get_instance_id())

func add_score(points: int) -> void:
	score += points
	emit_signal("score_changed", score)
