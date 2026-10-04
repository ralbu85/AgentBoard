import pytest
from backend.release import publish, validate


def build(folder, name, contents):
    (folder/'assets').mkdir(parents=True)
    (folder/'assets'/name).write_text(contents)
    (folder/'index.html').write_text(f'<script src="/assets/{name}"></script>')


def test_publish_preserves_previous_chunks_and_exact_rollback_backup(tmp_path):
    stage,live,releases=(tmp_path/p for p in ('stage','live','releases'))
    build(live,'app-old.js','old');build(stage,'app-new.js','new')
    old_index=(live/'index.html').read_bytes()
    release,receipt=publish(stage,live,releases,'commit')
    assert (live/'assets/app-old.js').read_text()=='old'
    assert (live/'assets/app-new.js').read_text()=='new'
    assert (release/'previous-dist/index.html').read_bytes()==old_index
    assert receipt['revision']=='commit' and receipt['verified'] is False
    assert (release/'receipt.json').stat().st_mode & 0o777 == 0o600


def test_invalid_build_is_rejected_before_replacing_live_index(tmp_path):
    stage=tmp_path/'stage';stage.mkdir()
    (stage/'index.html').write_text('<script src="/assets/missing.js"></script>')
    with pytest.raises(ValueError):validate(stage)
    (stage/'assets').mkdir();(stage/'assets/missing.js').symlink_to('/etc/passwd')
    with pytest.raises(ValueError):validate(stage)
