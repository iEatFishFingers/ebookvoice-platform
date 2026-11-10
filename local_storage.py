"""
Local-disk stand-in for Cloudinary, so the platform runs without a Cloudinary account.

Activated automatically when CLOUDINARY_CLOUD_NAME is not set. It replaces
`cloudinary.uploader.upload` and `cloudinary.uploader.destroy` with
implementations that write to LOCAL_MEDIA_DIR and serve the files from Flask
at /media/...

URLs keep Cloudinary's shape (`.../<resource_type>/upload/<public_id>.<ext>`),
so `extract_public_id()` and the delete paths work unchanged. As on
Cloudinary, image/video public_ids exclude the extension and raw public_ids
include it.

Production used real Cloudinary; this exists only for local runs.
"""

import io
import os
import glob
import shutil
import subprocess
import uuid

from flask import abort, send_from_directory

MEDIA_DIR = os.path.abspath(os.environ.get('LOCAL_MEDIA_DIR', 'local_media'))
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8080').rstrip('/')
_URL_PREFIX = f'{PUBLIC_BASE_URL}/media/'

# edge-tts streams 24 kHz / 48 kbps mono CBR MP3 → 6,000 bytes per second.
_EDGE_TTS_BYTES_PER_SECOND = 6000


def is_enabled() -> bool:
    return not os.environ.get('CLOUDINARY_CLOUD_NAME')


def _image_ext(data: bytes) -> str:
    if data[:3] == b'\xff\xd8\xff':
        return '.jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return '.png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return '.webp'
    if data[:4] == b'GIF8':
        return '.gif'
    return '.jpg'


def _audio_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return round(os.path.getsize(path) / _EDGE_TTS_BYTES_PER_SECOND, 3)


def _upload(file, resource_type='image', folder=None, public_id=None, **_ignored):
    """Mirror of cloudinary.uploader.upload for the argument shapes this codebase uses."""
    if isinstance(file, (str, os.PathLike)):
        with open(file, 'rb') as fh:
            data = fh.read()
    elif isinstance(file, (bytes, bytearray)):
        data = bytes(file)
    elif isinstance(file, io.IOBase) or hasattr(file, 'read'):
        data = file.read()
    else:
        raise TypeError(f'local_storage: unsupported upload source {type(file)!r}')

    pid = public_id or uuid.uuid4().hex
    if folder:
        pid = f'{folder.strip("/")}/{pid}'

    if resource_type == 'raw':
        ext = ''                        # raw public_ids carry their own extension
    elif resource_type == 'video':
        ext = '.mp3'
    else:
        ext = _image_ext(data)

    rel = f'{resource_type}/upload/{pid}{ext}'
    dest = os.path.join(MEDIA_DIR, *rel.split('/'))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as fh:
        fh.write(data)

    result = {
        'public_id': pid,
        'resource_type': resource_type,
        'bytes': len(data),
        'secure_url': _URL_PREFIX + rel,
        'url': _URL_PREFIX + rel,
    }
    if resource_type == 'video':
        result['duration'] = _audio_duration(dest)
    return result


def _destroy(public_id, resource_type='image', **_ignored):
    base = os.path.join(MEDIA_DIR, resource_type, 'upload', *public_id.split('/'))
    candidates = [base] if resource_type == 'raw' else glob.glob(glob.escape(base) + '.*')
    removed = False
    for path in candidates:
        if os.path.isfile(path):
            os.remove(path)
            removed = True
    return {'result': 'ok' if removed else 'not found'}


def read_local(url: str):
    """Return the bytes behind a local media URL, or None if the URL isn't local.

    Lets server-side code read its own media without an HTTP round trip — with
    gunicorn's single sync worker, a request to itself would deadlock.
    """
    if not url or not url.startswith(_URL_PREFIX):
        return None
    rel = url[len(_URL_PREFIX):]
    path = os.path.abspath(os.path.join(MEDIA_DIR, *rel.split('/')))
    if not path.startswith(MEDIA_DIR + os.sep) or not os.path.isfile(path):
        return None
    with open(path, 'rb') as fh:
        return fh.read()


def install(app, cloudinary_module) -> bool:
    """Patch Cloudinary and register the /media route if Cloudinary isn't configured."""
    if not is_enabled():
        return False

    os.makedirs(MEDIA_DIR, exist_ok=True)
    cloudinary_module.uploader.upload = _upload
    cloudinary_module.uploader.destroy = _destroy

    @app.route('/media/<path:rel>')
    def _local_media(rel):
        path = os.path.abspath(os.path.join(MEDIA_DIR, *rel.split('/')))
        if not path.startswith(MEDIA_DIR + os.sep) or not os.path.isfile(path):
            abort(404)
        mimetype = None
        if rel.startswith('raw/'):
            mimetype = 'application/json'
        elif rel.startswith('video/'):
            mimetype = 'audio/mpeg'
        return send_from_directory(os.path.dirname(path), os.path.basename(path),
                                   mimetype=mimetype, conditional=True)

    print(f'[storage] CLOUDINARY_CLOUD_NAME not set — using local disk at {MEDIA_DIR}, '
          f'served from {_URL_PREFIX}')
    return True


def clear():
    """Delete all locally stored media (used by tests / resets)."""
    shutil.rmtree(MEDIA_DIR, ignore_errors=True)
