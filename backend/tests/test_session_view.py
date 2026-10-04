import asyncio
import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend import config, routes_session_view as view, ws


def test_shared_operations_persist_without_overwriting_other_sessions(tmp_path,monkeypatch):
    monkeypatch.setattr(view,'STATE_FILE',tmp_path/'view.json')
    events=[]
    monkeypatch.setattr(ws,'broadcast',events.append)
    app=FastAPI();app.include_router(view.router)
    with TestClient(app) as client:
        assert client.get('/api/session-view').status_code==401
        client.cookies.set('token',config.AUTH_TOKEN)
        assert client.post('/api/session-view',json={'action':'visibility','key':'a','hidden':True},headers={'origin':'https://foreign.test'}).status_code==403
        for key in ['a','b']:
            assert client.post('/api/session-view',json={'action':'visibility','key':key,'hidden':True}).status_code==200
        client.post('/api/session-view',json={'action':'visibility','key':'a','hidden':False})
        client.post('/api/session-view',json={'action':'seed','items':['a','c']})
        client.post('/api/session-view',json={'action':'order','key':'workspace','items':['b','a']})
        state=client.get('/api/session-view').json()
        assert state['visibility']=={'a':False,'b':True,'c':True}
        assert state['orders']=={'workspace':['b','a']}
        assert state['revision']==5
        assert json.loads(view.STATE_FILE.read_text())==state
        assert events[-1]=={'type':'session-view',**state}


def test_cleanup_only_ended_online_sessions_once_preserves_records(tmp_path,monkeypatch):
    monkeypatch.setattr(view,'STATE_FILE',tmp_path/'view.json')
    events=[]
    monkeypatch.setattr(ws,'broadcast',events.append)
    records=[dict(id=str(i),sessionName='term-'+str(i),cwd='/연구',host='local',createdAt=100,status=status,aiState='idle',online=online)
             for i,(status,online) in enumerate([('running',True),('completed',True),('stopped',True),('completed',False)])]
    view.retire_ended(records)
    state=view.read_state()
    key=lambda i:json.dumps(['local','term-'+str(i),'/연구'],ensure_ascii=False,separators=(',',':'))
    assert state['visibility']=={key(1):True,key(2):True}
    assert len(records)==4 and records[0]['status']=='running'
    assert len(events)==1
    state['visibility'][key(1)]=False
    view.commit(state)
    view.retire_ended(records)
    assert view.read_state()['visibility'][key(1)] is False
    assert len(events)==2
    records[1]['createdAt']=200
    view.retire_ended(records)
    assert view.read_state()['visibility'][key(1)] is True
    assert len(events)==3


def test_status_broadcast_cleans_tabs_but_idle_update_does_not(tmp_path,monkeypatch):
    from backend.sessions import Session
    monkeypatch.setattr(view,'STATE_FILE',tmp_path/'view.json')
    session=Session(id='1',session_name='owned-test',cwd='/project',cmd='codex',created_at=123)
    monkeypatch.setattr(ws.store,'get',lambda sid:session)
    monkeypatch.setattr(ws,'clients',set())
    monkeypatch.setattr(ws.push,'maybe_push',lambda msg:None)
    ws.broadcast({'type':'aiState','id':'1','state':'idle'})
    assert not view.STATE_FILE.exists()
    ws.broadcast({'type':'status','id':'1','status':'completed'})
    assert view.read_state()['visibility']=={'["local","owned-test","/project"]':True}
