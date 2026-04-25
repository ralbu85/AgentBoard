import logging
import os
import sys


def _build_logger() -> logging.Logger:
    log = logging.getLogger("agentboard")
    if log.handlers:
        return log
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s.%(module)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    log.addHandler(handler)
    log.setLevel(os.getenv("AGENTBOARD_LOG_LEVEL", "INFO").upper())
    log.propagate = False
    return log


log = _build_logger()
