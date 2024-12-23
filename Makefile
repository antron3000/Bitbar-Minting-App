.PHONY:     all

all:    build down up

build:
		docker-compose build

down:
		docker-compose down --remove-orphans

up:
		docker-compose up -d
