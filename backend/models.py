from pydantic import BaseModel, Field
from typing import Optional


_SESSION_NAME_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"


class LoginRequest(BaseModel):
    pw: str

class SpawnRequest(BaseModel):
    cwd: str = ""
    cmd: str = ""

class InputRequest(BaseModel):
    id: str
    text: str

class KeyRequest(BaseModel):
    id: str
    key: str

class AttachRequest(BaseModel):
    sessionName: str = Field(pattern=_SESSION_NAME_PATTERN)
    cwd: str = ""

class FileWriteRequest(BaseModel):
    path: str
    content: str

class RenameRequest(BaseModel):
    from_path: str = Field(alias="from")
    to_path: str = Field(alias="to")

    model_config = {"populate_by_name": True}

class DeleteRequest(BaseModel):
    path: str

class MkdirRequest(BaseModel):
    path: str
