.PHONY: up down restart logs ps build clean

up:
	@docker compose up -d --build

down:
	@docker compose down
