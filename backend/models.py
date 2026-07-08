from pydantic import BaseModel, Field


_SESSION_NAME_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"
_HOST_PATTERN = r"^local$|^[a-z0-9_-]{1,32}$"
# Ids may be namespaced as "<host>:<localId>" for remote sessions, so the bound
# is larger than a bare local id (host<=32 + ':' + local).
_ID_MAX = 128
_PATH_MAX = 4096
_CONTENT_MAX = 10 * 1024 * 1024  # mirrors the 10MB read limit in routes_file
_INPUT_MAX = 1024 * 1024         # paste-friendly upper bound for terminal input


class LoginRequest(BaseModel):
    pw: str = Field(min_length=1, max_length=256)

class SpawnRequest(BaseModel):
    cwd: str = Field(default="", max_length=_PATH_MAX)
    cmd: str = Field(default="", max_length=_PATH_MAX)
    host: str = Field(default="local", pattern=_HOST_PATTERN)
    reqId: str = Field(default="", max_length=64)

class InputRequest(BaseModel):
    id: str = Field(min_length=1, max_length=_ID_MAX)
    text: str = Field(max_length=_INPUT_MAX)

class KeyRequest(BaseModel):
    id: str = Field(min_length=1, max_length=_ID_MAX)
    key: str = Field(min_length=1, max_length=64)

class AttachRequest(BaseModel):
    sessionName: str = Field(pattern=_SESSION_NAME_PATTERN)
    cwd: str = Field(default="", max_length=_PATH_MAX)

class SessionIdRequest(BaseModel):
    id: str = Field(min_length=1, max_length=_ID_MAX)

class FileWriteRequest(BaseModel):
    path: str = Field(min_length=1, max_length=_PATH_MAX)
    content: str = Field(max_length=_CONTENT_MAX)

class RenameRequest(BaseModel):
    from_path: str = Field(alias="from", min_length=1, max_length=_PATH_MAX)
    to_path: str = Field(alias="to", min_length=1, max_length=_PATH_MAX)

    model_config = {"populate_by_name": True}

class DeleteRequest(BaseModel):
    path: str = Field(min_length=1, max_length=_PATH_MAX)

class MkdirRequest(BaseModel):
    path: str = Field(min_length=1, max_length=_PATH_MAX)

class NotesSaveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=_PATH_MAX)
    # Bounded list so a client can't grow the on-disk notes file without limit.
    notes: list[dict] = Field(default_factory=list, max_length=10000)

class NoteDeleteRequest(BaseModel):
    path: str = Field(min_length=1, max_length=_PATH_MAX)
    startLine: int | None = None
    endLine: int | None = None

class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    keys: dict = Field(default_factory=dict)
    expirationTime: float | None = None

class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
