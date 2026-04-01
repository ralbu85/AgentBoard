from pydantic import BaseModel, Field
from typing import Optional


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
    sessionName: str
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
