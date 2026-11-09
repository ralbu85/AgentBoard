import time

from fastapi.testclient import TestClient

from backend import config, routes_preview as preview


def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'AUTH_TOKEN', 'fixture')
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    from fastapi import FastAPI
    app = FastAPI(); app.include_router(preview.router)
    return TestClient(app, cookies={'token': 'fixture'})


def site(tmp_path):
    (tmp_path / 'course' / '_site' / 'site_libs').mkdir(parents=True)
    (tmp_path / 'course' / '_site' / 'chapters' / '그림').mkdir(parents=True)
    (tmp_path / 'course' / '_quarto.yml').write_text('project: {}')
    (tmp_path / 'course' / '.env').write_text('SECRET=1')
    (tmp_path / 'course' / '_site' / 'site_libs' / 'app.css').write_text('p{color:red}')
    (tmp_path / 'course' / '_site' / 'chapters' / '그림' / 'a b.svg').write_text('<svg/>')
    page = tmp_path / 'course' / '_site' / 'chapters' / 'ch1.html'
    page.write_text('<link rel="stylesheet" href="../site_libs/app.css">')
    (tmp_path / 'outside.txt').write_text('no')
    return page


def test_a_page_reads_its_project_and_nothing_else(tmp_path, monkeypatch):
    c, page = client(tmp_path, monkeypatch), site(tmp_path)
    base = c.get('/api/preview-base', params={'path': str(page)}).json()
    assert base['root'] == str(tmp_path / 'course') and base['dir'] == '_site/chapters/'
    css = TestClient(c.app).get(base['prefix'] + '_site/site_libs/app.css')   # no cookie: the token grants it
    assert css.status_code == 200 and css.text == 'p{color:red}'
    assert css.headers['access-control-allow-origin'] == '*'
    assert css.headers['content-security-policy'] == 'sandbox allow-scripts'
    assert c.get(base['prefix'] + '_site/chapters/%EA%B7%B8%EB%A6%BC/a%20b.svg').status_code == 200
    for path in ['.env', '_site/../.env', '%2e%2e/outside.txt', '../outside.txt', '_site/chapters/']:
        assert c.get(base['prefix'] + path).status_code in (403, 404), path


def test_a_forged_or_expired_token_reads_nothing(tmp_path, monkeypatch):
    c, page = client(tmp_path, monkeypatch), site(tmp_path)
    forged = preview.sign(tmp_path, int(time.time()) + 60).split('.')[0] + '.' + 'x' * 43
    assert c.get(f'/api/preview/{forged}/outside.txt').status_code == 403
    expired = preview.sign(tmp_path / 'course', int(time.time()) - 1)
    assert c.get(f'/api/preview/{expired}/_quarto.yml').status_code == 403
    assert TestClient(c.app).get('/api/preview-base', params={'path': str(page)}).status_code == 401


def test_a_page_outside_a_project_gets_only_its_folder(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    (tmp_path / 'loose').mkdir(); (tmp_path / 'loose' / 'deck.html').write_text('<p>x</p>')
    assert c.get('/api/preview-base', params={'path': str(tmp_path / 'loose' / 'deck.html')}).json()['root'] == str(tmp_path / 'loose')

