"""AgentBoard remote agent.

Runs on a remote PC, wraps that machine's local tmux (by reusing the backend's
tmux/sessions/streamer/state_detector modules in this separate process), and
dials OUTBOUND to the hub's /agent-ws so it works behind NAT/firewalls.
"""
