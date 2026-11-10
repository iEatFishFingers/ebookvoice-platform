"""The local-disk Cloudinary stand-in must keep Cloudinary's URL and public_id semantics,
because extract_public_id() and the delete paths depend on them."""

import importlib
import io
import json
import types

import pytest
from flask import Flask


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.delenv('CLOUDINARY_CLOUD_NAME', raising=False)
    monkeypatch.setenv('LOCAL_MEDIA_DIR', str(tmp_path / 'media'))
    monkeypatch.setenv('PUBLIC_BASE_URL', 'http://test.local:8080')
    import local_storage
    importlib.reload(local_storage)

    app = Flask(__name__)
    fake_cloudinary = types.SimpleNamespace(uploader=types.SimpleNamespace())
    assert local_storage.install(app, fake_cloudinary) is True
    return local_storage, app, fake_cloudinary.uploader


def test_raw_public_id_keeps_extension(storage):
    ls, app, uploader = storage
    payload = json.dumps([{'word': 'hi', 'start': 0.0, 'end': 0.4}]).encode()
    res = uploader.upload(io.BytesIO(payload), resource_type='raw',
                          folder='word_timings', public_id='book_0.json', overwrite=True)
    assert res['public_id'] == 'word_timings/book_0.json'
    assert res['secure_url'] == 'http://test.local:8080/media/raw/upload/word_timings/book_0.json'
    assert json.loads(ls.read_local(res['secure_url'])) == json.loads(payload)

    assert uploader.destroy('word_timings/book_0.json', resource_type='raw') == {'result': 'ok'}
    assert ls.read_local(res['secure_url']) is None
    assert uploader.destroy('word_timings/book_0.json', resource_type='raw') == {'result': 'not found'}


def test_video_upload_reports_duration_and_strips_extension(storage, tmp_path):
    _, app, uploader = storage
    mp3 = tmp_path / 'a.mp3'
    mp3.write_bytes(b'\x00' * 12000)          # 2 s at edge-tts's 48 kbps if ffprobe is absent
    res = uploader.upload(str(mp3), resource_type='video')
    assert res['secure_url'].endswith('.mp3')
    assert '.' not in res['public_id']
    assert res['duration'] >= 0

    client = app.test_client()
    path = res['secure_url'].replace('http://test.local:8080', '')
    resp = client.get(path)
    assert resp.status_code == 200
    assert resp.mimetype == 'audio/mpeg'
    resp.close()                              # release the file handle (Windows locks open files)

    assert uploader.destroy(res['public_id'], resource_type='video') == {'result': 'ok'}


def test_image_extension_from_magic_bytes(storage):
    _, _, uploader = storage
    png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
    res = uploader.upload(io.BytesIO(png), resource_type='image', folder='audiobook_covers',
                          transformation=[{'width': 500}])
    assert res['secure_url'].endswith('.png')
    assert res['public_id'].startswith('audiobook_covers/')


def test_media_route_rejects_traversal_and_foreign_urls(storage):
    ls, app, _ = storage
    client = app.test_client()
    assert client.get('/media/../secrets.txt').status_code == 404
    assert ls.read_local('https://res.cloudinary.com/demo/raw/upload/x.json') is None
    assert ls.read_local('http://test.local:8080/media/../../etc/passwd') is None


def test_disabled_when_cloudinary_configured(monkeypatch):
    monkeypatch.setenv('CLOUDINARY_CLOUD_NAME', 'demo')
    import local_storage
    importlib.reload(local_storage)
    fake = types.SimpleNamespace(uploader=types.SimpleNamespace(upload='real', destroy='real'))
    assert local_storage.install(Flask(__name__), fake) is False
    assert fake.uploader.upload == 'real'
