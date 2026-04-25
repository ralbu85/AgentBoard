from pydantic import BaseModel, Field


_SESSION_NAME_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"
_PATH_MAX = 4096
_CONTENT_MAX = 10 * 1024 * 1024  # mirrors the 10MB read limit in routes_file
_INPUT_MAX = 1024 * 1024         # paste-friendly upper bound for terminal input


class LoginRequest(BaseModel):
    pw: str = Field(min_length=1, max_length=256)

class SpawnRequest(BaseModel):
    cwd: str = Field(default="", max_length=_PATH_MAX)
    cmd: str = Field(default="", max_length=_PATH_MAX)

class InputRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    text: str = Field(max_length=_INPUT_MAX)

class KeyRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=1, max_length=64)

class AttachRequest(BaseModel):
    sessionName: str = Field(pattern=_SESSION_NAME_PATTERN)
    cwd: str = Field(default="", max_length=_PATH_MAX)

class SessionIdRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)

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
