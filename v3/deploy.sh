#!/bin/bash
set -e
ROOT=/workspace/BALAB_Prof/agentboard
V=$(date +%s)
PORT=${AGENTBOARD_PORT:-3002}

echo "Building frontend..."
cd $ROOT/frontend && npx vite build --logLevel error

# Cache bust
sed -i "s|\.js\"|.js?v=$V\"|g; s|\.css\"|.css?v=$V\"|g" $ROOT/frontend/dist/index.html

echo "Restarting server..."
kill $(lsof -ti:$PORT) 2>/dev/null || true
sleep 1
nohup $ROOT/start.sh > $ROOT/server.log 2>&1 &

for i in $(seq 1 10); do
  if curl -s -o /dev/null -w '' http://localhost:$PORT/ 2>/dev/null; then
    echo "Server ready on :$PORT (v=$V)"
    exit 0
  fi
  sleep 0.5
done
echo "ERROR: Server failed to start"
cat $ROOT/server.log
exit 1
