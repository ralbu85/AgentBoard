#!/bin/bash
# Waiting agent that RESPONDS to the approve keypress and continues — powers
# the "tap Yes from anywhere" moment in the README GIFs.
p(){ printf "$1\n"; }
p '\e[1m> add rate limiting to the public API endpoints\e[0m'; p ''
p '\e[32m⏺\e[0m \e[1mRead\e[0m src/server.py \e[90m(214 lines)\e[0m'
p '\e[32m⏺\e[0m \e[1mRead\e[0m src/routes/public.py \e[90m(96 lines)\e[0m'
p '\e[32m⏺\e[0m \e[1mSearch\e[0m "@app.get" \e[90m— 9 public endpoints\e[0m'; p ''
p '\e[90m  Nine endpoints are exposed without any throttle. slowapi integrates\e[0m'
p '\e[90m  cleanly with FastAPI, so I will add a shared per-IP limiter (60/min)\e[0m'
p '\e[90m  and a stricter bucket for /search (10/min), then cover it with tests.\e[0m'; p ''
p '\e[32m⏺\e[0m \e[1mUpdate\e[0m src/server.py \e[90m+28 -2\e[0m'
p '\e[32m⏺\e[0m \e[1mUpdate\e[0m src/routes/public.py \e[90m+14 -1\e[0m'
p '\e[32m⏺\e[0m \e[1mWrite\e[0m tests/test_ratelimit.py \e[90m(61 lines)\e[0m'; p ''
p '\e[1mBash command\e[0m'; p ''
p '  \e[36mpip install slowapi && pytest tests/test_ratelimit.py -q\e[0m'
p '  Install the rate-limit dependency and run the new tests'; p ''
p 'Do you want to proceed?'
p '\e[36m❯ 1. Yes\e[0m'
p '  2. Yes, and dont ask again this session'
p '  3. No, and tell Claude what to do differently (esc)'
read -rsn1 _
p ''; p '\e[90m  ⎿ Yes\e[0m'; p ''
sleep 0.6
p '\e[32m⏺\e[0m \e[1mBash\e[0m pip install slowapi && pytest tests/test_ratelimit.py -q'; p ''
sleep 0.9
p '  Collecting slowapi'
sleep 0.6
p '  Installing collected packages: slowapi'
p '  Successfully installed slowapi-0.1.9'; p ''
sleep 0.9
p '  \e[32m........\e[0m                                                        [100%%]'
sleep 0.5
p '  \e[32m8 passed\e[0m in 2.31s'; p ''
sleep 0.7
p '\e[32m✓\e[0m Rate limiting is live on all 9 endpoints — 60/min default, 10/min on /search.'; p ''
p '\e[90m? for shortcuts · shift+tab to cycle\e[0m'
sleep 100000
