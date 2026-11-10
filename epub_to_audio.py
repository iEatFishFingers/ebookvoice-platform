from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
from flask_compress import Compress
from datetime import datetime, timezone as dt_timezone
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import webbrowser
import threading
import tempfile
import os
import io
import base64
import zipfile
import edge_tts
import asyncio
import time
import secrets
import math
import re
import json
import requests as http_requests
from dotenv import load_dotenv
import cloudinary
import cloudinary.uploader

# Load environment variables from .env file FIRST
load_dotenv()

# Import auth after loading env vars
from auth import require_auth, get_user_profile, get_supabase_client, TERMS_VERSION

# Import security module
from security import (
    optional_auth,
    require_task_ownership,
    rate_limit,
    init_security_headers,
    init_error_handlers,
    validate_voice_id,
    validate_task_id,
    validate_audiobook_id,
    validate_text_content,
    validate_epub_file,
    validate_docx_file,
    validate_daisy_file,
    ValidationError,
    SecureEpubParser,
    extract_docx_chapters,
    extract_daisy_chapters,
    log_security_event,
)
from security.audit_log import SecurityAuditLog

# Import voice manager
from voice_manager import get_voice_manager

# Import task manager
from task_manager import TaskManager

# Import Stripe service
from stripe_utils import StripeService
import stripe

# ── Author Pro feature modules ────────────────────────────────────────────────
from concurrent.futures import (
    ThreadPoolExecutor,
    as_completed,
    TimeoutError as FuturesTimeoutError,
)
from word_timing import (
    generate_audio_with_timings,
    generate_synthetic_timings as _generate_synthetic_timings,
    sanitize_word_timings,
    synthesize_in_chunks_async,
    group_word_timings_into_chunks,
)
from emotional_director import get_prosody_params, analyze_chapter_emotions, detect_emotion, EMOTION_PROFILES
from voice_suggester import suggest_voices, analyze_writing_style
from analytics import analytics_bp

app = Flask(__name__)

# Gzip every response > 500 bytes. JSON compresses 5-10× (a 6 MB /api/audiobooks
# payload becomes ~600 KB). Worth ~10x bandwidth + transient memory savings.
# audio/* and image/* are already compressed so Flask-Compress skips them.
app.config['COMPRESS_MIN_SIZE'] = 500
app.config['COMPRESS_LEVEL'] = 6   # 1=fastest..9=smallest. 6 is a good balance.
Compress(app)

# Configure Cloudinary
cloudinary.config(
  cloud_name = os.environ.get('CLOUDINARY_CLOUD_NAME'),
  api_key = os.environ.get('CLOUDINARY_API_KEY'),
  api_secret = os.environ.get('CLOUDINARY_API_SECRET')
)

# Without Cloudinary credentials, store media on local disk instead (local runs only).
import local_storage
local_storage.install(app, cloudinary)

# Enable CORS for mobile app access
# SECURITY: In production, ALLOWED_ORIGINS must be configured (no wildcard)
_allowed_origins_raw = os.environ.get('ALLOWED_ORIGINS', '')
allowed_origins = [o.strip() for o in _allowed_origins_raw.split(',') if o.strip()]

# In development, allow localhost if no origins specified
if not allowed_origins:
    debug_mode = os.environ.get('DEBUG', 'false').lower() in ('true', '1', 'yes')
    if debug_mode:
        # Detect local LAN IP for physical device testing
        import socket
        try:
            _s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            _s.connect(('8.8.8.8', 80))
            _lan_ip = _s.getsockname()[0]
            _s.close()
        except Exception:
            _lan_ip = '127.0.0.1'

        allowed_origins = [
            'http://localhost:3000',
            'http://localhost:8080',
            'http://localhost:8081',   # Expo web (modern SDK)
            'http://localhost:19000',  # Expo Metro bundler
            'http://localhost:19006',  # Expo web (legacy SDK)
            'http://127.0.0.1:3000',
            'http://127.0.0.1:8080',
            'http://127.0.0.1:8081',
            'http://10.0.2.2:8080',   # Android emulator → Flask
            # Physical device on same LAN
            f'http://{_lan_ip}:8080',
            f'http://{_lan_ip}:8081',
            f'http://{_lan_ip}:3000',
        ]
        print('[SECURITY] WARNING: Using development CORS origins')
    else:
        # Production requires explicit origins
        print('[SECURITY] WARNING: ALLOWED_ORIGINS not configured, CORS will be restrictive')
        allowed_origins = []

CORS(app, resources={
    r"/*": {
        "origins": allowed_origins if allowed_origins else [],
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Device-Id"]
    }
})

# Initialize security headers and error handlers
init_security_headers(app)
init_error_handlers(app)

# Register Author Pro analytics blueprint
app.register_blueprint(analytics_bp)

# ==================== Cloudinary Helper Functions ====================

def extract_public_id(cloudinary_url):
    """
    Extract public_id from Cloudinary URL.

    Example URLs:
    - https://res.cloudinary.com/cloud_name/video/upload/v123456/abc123.mp3 -> v123456/abc123
    - https://res.cloudinary.com/cloud_name/video/upload/abc123.mp3 -> abc123
    - URLs may contain spaces or URL-encoded characters (%20)

    Args:
        cloudinary_url: Full Cloudinary URL

    Returns:
        str: public_id or None if URL is invalid
    """
    if not cloudinary_url or '/upload/' not in cloudinary_url:
        print(f'⚠️ Invalid Cloudinary URL (missing /upload/): {cloudinary_url}')
        return None

    try:
        # URL decode to handle %20 and other encoded characters
        from urllib.parse import unquote
        decoded_url = unquote(cloudinary_url)

        print(f'🔗 Original URL: {cloudinary_url}')
        if decoded_url != cloudinary_url:
            print(f'🔗 Decoded URL: {decoded_url}')

        # Split by '/upload/' and take the second part
        parts = decoded_url.split('/upload/')
        if len(parts) != 2:
            print(f'⚠️ Invalid Cloudinary URL format: {decoded_url}')
            return None

        # Get the part after /upload/
        path_after_upload = parts[1]

        print(f'🔍 Path after /upload/: {path_after_upload}')

        # Remove file extension (e.g., .mp3)
        # Handle both with and without extension
        if '.' in path_after_upload:
            public_id_with_version = path_after_upload.rsplit('.', 1)[0]
        else:
            public_id_with_version = path_after_upload

        print(f'🔑 Extracted public_id (with spaces): "{public_id_with_version}"')
        return public_id_with_version
    except Exception as e:
        print(f'❌ Error extracting public_id from {cloudinary_url}: {e}')
        import traceback
        traceback.print_exc()
        return None


def delete_cloudinary_asset(cloudinary_url, max_retries=1):
    """
    Delete asset from Cloudinary with retry logic.

    Args:
        cloudinary_url: Full Cloudinary URL of the asset
        max_retries: Number of retry attempts (default 1)

    Returns:
        bool: True if deletion successful, False otherwise
    """
    if not cloudinary_url:
        return True  # Nothing to delete

    print(f'🗑️ Attempting to delete: {cloudinary_url}')

    for attempt in range(max_retries + 1):
        try:
            public_id = extract_public_id(cloudinary_url)

            if not public_id:
                print(f'⚠️ Could not extract public_id from: {cloudinary_url}')
                return False

            # Try deletion with full public_id (including version)
            print(f'📤 Attempt with version: cloudinary.uploader.destroy(public_id="{public_id}", resource_type="video")')
            result = cloudinary.uploader.destroy(public_id, resource_type="video", invalidate=True)
            print(f'📥 Cloudinary response: {result}')

            # If not found and public_id contains version prefix (v followed by numbers/),
            # try without version
            if result.get('result') == 'not found' and '/' in public_id:
                parts = public_id.split('/', 1)
                if len(parts) == 2 and parts[0].startswith('v') and parts[0][1:].isdigit():
                    public_id_without_version = parts[1]
                    print(f'🔄 Retry without version: "{public_id_without_version}"')
                    result = cloudinary.uploader.destroy(public_id_without_version, resource_type="video", invalidate=True)
                    print(f'📥 Cloudinary response (no version): {result}')

            # Check if deletion was successful
            if result.get('result') == 'ok':
                print(f'✅ Deleted Cloudinary asset: {public_id}')
                return True
            elif result.get('result') == 'not found':
                print(f'⚠️ Cloudinary asset not found: {public_id}')
                print(f'   This could mean:')
                print(f'   1. File was already deleted')
                print(f'   2. The public_id format is incorrect')
                print(f'   3. The file never existed')
                # Still return True since the goal (file not existing) is achieved
                return True
            else:
                # Unknown result, might need retry
                if attempt < max_retries:
                    print(f'⚠️ Unexpected result, retrying...')
                    time.sleep(1)
                    continue
                return True  # Continue deletion even if Cloudinary fails

        except Exception as e:
            if attempt < max_retries:
                print(f'⚠️ Error deleting Cloudinary asset (attempt {attempt + 1}): {e}, retrying...')
                time.sleep(1)
                continue
            else:
                print(f'❌ Failed to delete Cloudinary asset {cloudinary_url} after {max_retries + 1} attempts: {e}')
                import traceback
                traceback.print_exc()
                return False

    return False

# ==================== EPUB Processing Functions ====================

def extract_epub_text(epub_path):
    """Extract all text from EPUB file."""
    book = epub.read_epub(epub_path)
    full_text = []

    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            soup = BeautifulSoup(item.get_content(), 'html.parser')
            text = soup.get_text(separator=' ', strip=True)
            if text:
                full_text.append(text)

    return ' '.join(full_text)

def _is_valid_chapter_title(text):
    """
    Check if text is a valid chapter title.
    Filters out file paths, UUIDs, and other invalid patterns.
    """
    import re

    if not text:
        return False

    # Filter out file paths
    if text.startswith('/') or text.startswith('\\'):
        return False
    if '/app/' in text or '\\app\\' in text:
        return False
    if '/public/' in text or '\\public\\' in text:
        return False
    if text.endswith('.pdf') or text.endswith('.epub') or text.endswith('.html'):
        return False

    # Filter out UUIDs and hex strings (common in generated paths)
    if re.search(r'[a-f0-9]{16,}', text.lower()):
        return False

    # Filter out paths with multiple slashes
    if text.count('/') > 2 or text.count('\\') > 2:
        return False

    # Filter out very long "titles" that are likely paths or encoded data
    if len(text) > 200:
        return False

    # Filter out titles that are just numbers or very short
    if text.isdigit() or len(text) < 2:
        return False

    return True


def _extract_toc_from_epub(book):
    """
    Extract Table of Contents titles from EPUB.
    Returns a dict mapping file names to titles.
    """
    toc_titles = {}

    try:
        # Try to get TOC from ebooklib
        toc = book.toc
        if toc:
            def process_toc_item(item):
                if isinstance(item, tuple):
                    # It's a section with children
                    section, children = item
                    if hasattr(section, 'title') and hasattr(section, 'href'):
                        href = section.href.split('#')[0] if section.href else ''
                        if href and section.title:
                            toc_titles[href] = section.title
                    for child in children:
                        process_toc_item(child)
                elif hasattr(item, 'title') and hasattr(item, 'href'):
                    # It's a link
                    href = item.href.split('#')[0] if item.href else ''
                    if href and item.title:
                        toc_titles[href] = item.title

            for item in toc:
                process_toc_item(item)
    except Exception as e:
        print(f'[EPUB] Error extracting TOC: {e}')

    return toc_titles


def extract_epub_chapters(epub_path):
    """Extract chapters from EPUB file with titles and content."""
    book = epub.read_epub(epub_path)
    chapters = []
    chapter_num = 1

    # Extract TOC titles for better chapter naming
    toc_titles = _extract_toc_from_epub(book)

    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            soup = BeautifulSoup(item.get_content(), 'html.parser')

            # Extract text content
            text = soup.get_text(separator=' ', strip=True)

            if not text:
                continue

            title = None

            # Priority 1: Check TOC for title
            item_href = item.get_name()
            if item_href in toc_titles:
                title = toc_titles[item_href]
            else:
                # Try matching by filename only
                import os
                item_basename = os.path.basename(item_href)
                for toc_href, toc_title in toc_titles.items():
                    if os.path.basename(toc_href) == item_basename:
                        title = toc_title
                        break

            # Priority 2: Try to find chapter title from h1, h2, h3
            if not title:
                for tag in ['h1', 'h2', 'h3']:
                    title_tag = soup.find(tag)
                    if title_tag:
                        candidate = title_tag.get_text(strip=True)
                        if candidate and _is_valid_chapter_title(candidate):
                            title = candidate
                            break

            # Priority 3: Try <title> tag (but validate it)
            if not title:
                title_tag = soup.find('title')
                if title_tag:
                    candidate = title_tag.get_text(strip=True)
                    if candidate and _is_valid_chapter_title(candidate):
                        title = candidate

            # Fallback: Use "Chapter X"
            if not title:
                title = f"Chapter {chapter_num}"

            chapters.append({
                'id': str(chapter_num),
                'title': title,
                'content': text,
                'duration': 0,
                'position': chapter_num - 1
            })
            chapter_num += 1

    return chapters

# Selected storytelling voices with preview text


# ── Word-timing CDN offload ───────────────────────────────────────────────────
# Karaoke timings are one entry per word (~400 KB on a 5,000-word chapter).
# Stored as JSONB they dominate the Supabase database, dominate the wire on
# every book open, and blow the per-statement timeout (57014) that makes long
# books silently lose karaoke.  They are immutable once generated and only the
# Player reads them, so they live on Cloudinary beside the chapter's MP3 and
# Postgres keeps only the URL (migration 016).
#
# Uploaded as plain (whitespace-stripped) JSON rather than gzipped: Cloudinary
# applies gzip transfer-encoding for compressible types on the way out, and a
# plain .json file is what the phase-2 client can fetch and JSON.parse directly
# without a gunzip step in React Native.

WORD_TIMINGS_FOLDER = 'word_timings'
WORD_TIMINGS_FETCH_TIMEOUT_S = 5
WORD_TIMINGS_HYDRATE_BUDGET_S = 8


def upload_word_timings(word_timings, chapter_key: str):
    """
    Upload one chapter's word timings to Cloudinary as raw JSON.

    Returns the secure URL, or None if there was nothing to upload or the
    upload failed.  A None return means the caller should fall back to writing
    the blob inline — degraded (it costs database size) but never lossy.
    """
    if not word_timings:
        return None
    try:
        payload = json.dumps(word_timings, separators=(',', ':')).encode('utf-8')
        result = cloudinary.uploader.upload(
            io.BytesIO(payload),
            resource_type='raw',
            folder=WORD_TIMINGS_FOLDER,
            public_id=f'{chapter_key}.json',
            # Explicit rather than relying on Cloudinary's defaults: a recovery
            # script re-running a chapter must replace the JSON and purge the
            # edge cache, not quietly leave the old timings being served.
            overwrite=True,
            invalidate=True,
            timeout=30,
        )
        url = result.get('secure_url')
        if url:
            print(f'  [word_timing] ↑ {len(word_timings)} timings → CDN ({len(payload) // 1024} KB)')
        return url
    except Exception as exc:
        print(f'[WARN] word_timings upload failed for {chapter_key}: {exc}')
        return None


def fetch_word_timings(url: str):
    """Fetch one chapter's timings back from the CDN. None on any failure."""
    if not url:
        return None
    try:
        local = local_storage.read_local(url)
        if local is not None:
            return json.loads(local)
        resp = http_requests.get(url, timeout=WORD_TIMINGS_FETCH_TIMEOUT_S)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        print(f'[WARN] word_timings fetch failed ({url}): {exc}')
        return None


def hydrate_word_timings(chapters: list) -> list:
    """
    Fill each chapter's `word_timings` from its `word_timings_url`, in place.

    Keeps GET /api/audiobooks/<id> returning the exact response shape that
    builds 38 and 39 expect, so offloading storage needs no app release.

    Rows that already carry inline timings (legacy, pre-migration-016) are left
    alone.  Runs the fetches in a small thread pool — they are I/O bound and
    gunicorn is `workers=1 / sync / threads=1`, so blocking serially here would
    stall every other request including the 3-second /status poll.

    Degrades to `word_timings: None` rather than raising: karaoke is worth a
    retry on the next open, it is not worth a 500 on the whole book.
    """
    pending = [
        ch for ch in chapters
        if not ch.get('word_timings') and ch.get('word_timings_url')
    ]
    if not pending:
        return chapters

    pool = ThreadPoolExecutor(max_workers=4)
    try:
        future_map = {
            pool.submit(fetch_word_timings, ch['word_timings_url']): ch
            for ch in pending
        }
        for future in as_completed(future_map, timeout=WORD_TIMINGS_HYDRATE_BUDGET_S):
            chapter = future_map[future]
            try:
                chapter['word_timings'] = future.result()
            except Exception as exc:
                print(f"[WARN] word_timings hydration failed for chapter "
                      f"{chapter.get('position')}: {exc}")
                chapter['word_timings'] = None
    except FuturesTimeoutError:
        print(f'[WARN] word_timings hydration exceeded '
              f'{WORD_TIMINGS_HYDRATE_BUDGET_S}s; remaining chapters served '
              f'without karaoke')
    finally:
        # NOT a `with` block: ThreadPoolExecutor.__exit__ calls
        # shutdown(wait=True), which waits for every queued fetch to finish
        # regardless of the budget above — on a 40-chapter book with a slow
        # CDN that is 10 batches x the request timeout, all of it blocking the
        # single sync gunicorn worker. Cancel what hasn't started and return.
        pool.shutdown(wait=False, cancel_futures=True)
    return chapters


# ── Background image-upload cache ─────────────────────────────────────────────
# /extract-chapters returns text immediately and hands image uploads to a
# daemon thread.  The worker reads results here before saving to the DB.
#
# Schema: { upload_id: { 'status': 'pending'|'done',
#                         'by_chapter_id': { chapter_id: [imageInsert, …] } } }
_image_upload_cache: dict = {}
_image_upload_lock = threading.Lock()


def _bg_upload_images(upload_id: str, tasks: list) -> None:
    """
    Background thread: upload EPUB inline images to Cloudinary in parallel,
    then mark the cache entry 'done'.

    tasks: list of {chapter_id, word_index, img_bytes, abs_path}
    Results are stored by chapter_id so they survive chapter deletions made
    by the user during the EbookReview step.
    """
    from collections import defaultdict

    results: dict = defaultdict(list)

    def _upload_one(task):
        result = cloudinary.uploader.upload(
            io.BytesIO(task['img_bytes']),
            resource_type='image',
            folder='epub_images',
            transformation=[
                {'width': 800, 'crop': 'limit'},
                {'quality': 'auto', 'fetch_format': 'auto'},
            ],
            timeout=20,
        )
        return result.get('secure_url')

    # 4 workers (was 8) keeps peak image-upload memory ≤ ~1 MB on Render Starter.
    with ThreadPoolExecutor(max_workers=4) as pool:
        future_map = {pool.submit(_upload_one, t): t for t in tasks}
        for future in as_completed(future_map):
            task = future_map[future]
            try:
                url = future.result()
                if url:
                    results[task['chapter_id']].append(
                        {'wordIndex': task['word_index'], 'url': url}
                    )
                    print(f'[BG-IMG] Uploaded {task["abs_path"]}')
            except Exception as e:
                print(f'[BG-IMG] Skipped {task["abs_path"]}: {e}')
            finally:
                # Release image bytes as soon as each upload completes so all 30
                # don't sit in RAM until the whole batch is done.
                task['img_bytes'] = None

    # Sort each chapter's inserts by word order
    final = {
        ch_id: sorted(inserts, key=lambda x: x['wordIndex'])
        for ch_id, inserts in results.items()
    }
    with _image_upload_lock:
        _image_upload_cache[upload_id] = {'status': 'done', 'by_chapter_id': final}

    total = sum(len(v) for v in final.values())
    print(f'[BG-IMG] Complete for {upload_id}: {total} image(s) across {len(final)} chapter(s)')


VOICES = {
    "Sonia (UK Female - Storytelling)": "en-GB-SoniaNeural",
    "Tony (US Male - Mature Narrator)": "en-US-TonyNeural",
    "Davis (US Male - Smooth Narrator)": "en-US-DavisNeural",
    "Andrew (US Male - Expressive)": "en-US-AndrewNeural",
    "Emma (US Female - Cheerful)": "en-US-EmmaNeural",
}

# Native-language preview text keyed by ISO 639-1 code.
# Each sentence introduces the voice in the listener's own language so
# non-English speakers can judge pronunciation and prosody correctly.
PREVIEW_TEXTS: dict = {
    'en': "Hello! This is an AI voice. If you like the sound of my voice, please choose me for your audiobook.",
    'es': "¡Hola! Soy una voz de inteligencia artificial. Si te gusta cómo sueno, elígeme para tu audiolibro.",
    'fr': "Bonjour ! Je suis une voix artificielle. Si le son de ma voix vous plaît, choisissez-moi pour votre livre audio.",
    'de': "Hallo! Das ist eine KI-Stimme. Wenn Ihnen meine Stimme gefällt, wählen Sie mich für Ihr Hörbuch aus.",
    'it': "Ciao! Questa è una voce artificiale. Se ti piace il suono della mia voce, sceglimi per il tuo audiolibro.",
    'pt': "Olá! Esta é uma voz de IA. Se você gosta do som da minha voz, me escolha para o seu audiolivro.",
    'nl': "Hallo! Dit is een AI-stem. Als u van mijn stem houdt, kies mij dan voor uw luisterboek.",
    'pl': "Cześć! To jest głos sztucznej inteligencji. Jeśli podoba ci się mój głos, wybierz mnie do swojego audiobooka.",
    'ru': "Привет! Это голос искусственного интеллекта. Если вам нравится мой голос, выберите меня для аудиокниги.",
    'zh': "你好！我是人工智能语音。如果您喜欢我的声音，请选择我为您的有声书服务。",
    'ja': "こんにちは！これはAIの声です。私の声が気に入ったら、オーディオブックにぜひ選んでください。",
    'ko': "안녕하세요! 저는 AI 음성입니다. 제 목소리가 마음에 드신다면, 오디오북 변환에 저를 선택해 주세요.",
    'ar': "مرحباً! هذا صوت ذكاء اصطناعي. إذا أعجبك صوتي، يرجى اختياري لتحويل كتابك المسموع.",
    'hi': "नमस्ते! यह एक AI आवाज़ है। अगर आपको मेरी आवाज़ पसंद है, तो कृपया मुझे अपनी ऑडियोबुक के लिए चुनें।",
    'tr': "Merhaba! Bu bir yapay zeka sesidir. Sesimi beğendiyseniz, lütfen sesli kitabınız için beni seçin.",
    'cy': "Helo! Llais deallusrwydd artiffisial yw hwn. Os ydych chi'n hoffi sain fy llais, dewiswch fi ar gyfer eich llyfr llafar.",
    'ga': "Dia duit! Guth intleachta saorga é seo. Más maith leat fuaim mo ghutha, roghnaigh mé le do thoil do d'fhíseán closleabhair.",
    'uk': "Привіт! Це голос штучного інтелекту. Якщо вам подобається мій голос, оберіть мене для вашої аудіокниги.",
    'el': "Γεια σας! Αυτή είναι μια φωνή τεχνητής νοημοσύνης. Αν σας αρέσει η φωνή μου, επιλέξτε με για το ηχητικό σας βιβλίο.",
    'he': "שלום! זהו קול של בינה מלאכותית. אם אתם אוהבים את צליל קולי, אנא בחרו בי עבור ספר השמע שלכם.",
    'sv': "Hej! Det här är en AI-röst. Om du gillar min röst, välj mig för din ljudbok.",
    'da': "Hej! Dette er en AI-stemme. Hvis du kan lide min stemme, så vælg mig til din lydbog.",
    'nb': "Hei! Dette er en AI-stemme. Hvis du liker stemmen min, velg meg til lydboken din.",
    'fi': "Hei! Tämä on tekoälyääni. Jos pidät äänestäni, valitse minut äänikirjaasi varten.",
    'cs': "Ahoj! Toto je hlas umělé inteligence. Pokud se vám můj hlas líbí, vyberte si mě pro svou audioknihu.",
    'hu': "Helló! Ez egy mesterséges intelligencia hang. Ha tetszik a hangom, válasszon engem a hangoskönyvéhez.",
    'ro': "Bună! Aceasta este o voce de inteligență artificială. Dacă îți place vocea mea, alege-mă pentru cartea ta audio.",
}

def _preview_text_for_voice(voice_id: str) -> str:
    """Return the native-language preview sentence for a given voice ID."""
    lang = voice_id.split('-')[0].lower()
    return PREVIEW_TEXTS.get(lang, PREVIEW_TEXTS['en'])


def get_voice_name(voice_id):
    """Get voice display name from voice ID"""
    # First check dynamic voices from voice_manager
    try:
        vm = get_voice_manager()
        voice_name = vm.get_voice_name(voice_id)
        if voice_name and voice_name != 'AI Voice':
            return voice_name
    except Exception as e:
        print(f"[!] Error getting voice name from manager: {e}")

    # Fallback to hardcoded VOICES dictionary
    for name, vid in VOICES.items():
        if vid == voice_id:
            return name

    return 'AI Voice'

async def create_preview_async(voice_id, output_path):
    """
    Create a preview sample for a voice in its native language.

    Never leaves a partial file behind. edge_tts' save() opens the output
    before it streams, so a refused synthesis (NoAudioReceived — routine now
    that Microsoft rate-limits the endpoint) leaves a ZERO-BYTE file. The
    caller caches previews by existence, so one refusal would otherwise serve
    silence for that voice for the life of the container.
    Raising instead of returning an empty file keeps "succeeded" honest.
    → [[preview-cache-poisoned-by-failed-synthesis]]
    """
    text = _preview_text_for_voice(voice_id)
    communicate = edge_tts.Communicate(text, voice_id)
    try:
        await communicate.save(output_path)
        if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            raise RuntimeError(f'preview synthesis produced no audio for {voice_id}')
    except Exception:
        if os.path.exists(output_path):
            try:
                os.remove(output_path)
            except OSError:
                pass  # best effort — the size check on read also covers us
        raise
    return output_path

async def create_audiobook_async(text, output_path, voice_id, progress_callback=None):
    """Convert text to audio using chunked parallel TTS synthesis."""
    await synthesize_in_chunks_async(
        text, voice_id, output_path,
        progress_callback=progress_callback,
    )
    return output_path

def create_audiobook(text, output_path, voice_id, progress_callback=None):
    """Wrapper to run async Edge TTS in sync context."""
    return asyncio.run(create_audiobook_async(text, output_path, voice_id, progress_callback))


async def create_chapter_audio_with_timings_async(
    text: str,
    output_path: str,
    voice_id: str,
    use_emotional_director: bool = False,
    emotion_override: str = None,
    progress_callback=None,
):
    """
    Convert chapter text to audio and return word-level timing data.

    When use_emotional_director is True, the text is first wrapped in SSML
    with prosody adjustments for the detected emotional register.

    Returns (word_timings list, detected_emotion str or None).
    """
    detected_emotion = None

    if use_emotional_director:
        detected_emotion, _, _ = detect_emotion(text)
        prosody = get_prosody_params(text, emotion=emotion_override or detected_emotion)
        word_timings = await synthesize_in_chunks_async(
            text, voice_id, output_path,
            rate=prosody["rate"], pitch=prosody["pitch"], volume=prosody["volume"],
            progress_callback=progress_callback,
        )
    else:
        word_timings = await synthesize_in_chunks_async(
            text, voice_id, output_path,
            progress_callback=progress_callback,
        )

    return word_timings, detected_emotion


def create_chapter_audio_with_timings(
    text: str,
    output_path: str,
    voice_id: str,
    use_emotional_director: bool = False,
    emotion_override: str = None,
    progress_callback=None,
):
    """Sync wrapper for create_chapter_audio_with_timings_async."""
    return asyncio.run(
        create_chapter_audio_with_timings_async(
            text, output_path, voice_id,
            use_emotional_director=use_emotional_director,
            emotion_override=emotion_override,
            progress_callback=progress_callback,
        )
    )


@app.route('/')
def index():
    # This is the old web UI, it can be removed or updated later
    return "EbookVoice Backend is running."


@app.route('/api/queue-status', methods=['GET'])
def queue_status():
    """
    Counts only — `{queued, processing, busy}` — no titles, no ids, no auth.

    Exists so the push-time check behind the hard rule "never push to main
    while a conversion is running" is something a script can run, not a
    memory. It has been answered from memory three times (2026-05-28,
    2026-09-11, 2026-09-12) and each time a deploy restarted the container
    mid-book. `scripts/pre-push-queue-check.sh` calls this from a git
    pre-push hook and refuses the push while `busy` is true; it is also a
    better uptime-monitor target than /api/feature-flags because it proves
    the database, not just the process.
    """
    try:
        supabase = get_supabase_client()
        counts = {}
        for status in ('queued', 'processing'):
            res = supabase.table('conversion_tasks') \
                .select('id', count='exact') \
                .eq('queue_status', status) \
                .limit(1) \
                .execute()
            counts[status] = res.count or 0
        return jsonify({
            'queued': counts['queued'],
            'processing': counts['processing'],
            'busy': (counts['queued'] + counts['processing']) > 0,
        })
    except Exception as e:
        # Fail loud, not "0 — safe to push": the hook treats non-200 as busy.
        print(f'[queue-status] lookup failed: {e}')
        return jsonify({'error': 'queue lookup failed'}), 503


@app.route('/api/feature-flags', methods=['GET'])
def feature_flags():
    """
    Remote feature flags read by the mobile app at launch.

    Currently controls:
    - rntp_enabled: when True, mobile audio uses react-native-track-player
      (with lock-screen / Bluetooth / CarPlay controls).  When False, falls
      back to the legacy expo-av path that's also compiled into the binary.
      Acts as a server-side kill-switch in case RNTP causes audio
      regressions in production.

    Override via env var FEATURE_RNTP_ENABLED ("true"/"false").  Default is
    False so RNTP stays dormant until we explicitly enable it.
    """
    rntp = os.environ.get('FEATURE_RNTP_ENABLED', 'false').strip().lower() in ('1', 'true', 'yes')
    return jsonify({
        'rntp_enabled': rntp,
    })

# Initialize TaskManager for database-backed task storage (multi-worker support)
task_manager = TaskManager(get_supabase_client())

# Queue system
from queue_manager import enqueue_task, register_handler

# Initialize security audit log
audit_log = SecurityAuditLog(get_supabase_client())

@app.route('/preview')
def preview():
    voice_id = request.args.get('voice')
    if not voice_id:
        return jsonify({'error': 'No voice specified'}), 400

    # "prevn_" prefix = native-language preview (busts old English-only cache).
    preview_path = os.path.join(tempfile.gettempdir(), f'prevn_{voice_id.replace("-", "_")}.mp3')

    # A zero-byte cache entry counts as ABSENT, not as a hit. Previews are
    # cached by existence alone, and a refused synthesis used to leave an empty
    # file here — after which every request returned 200 audio/mpeg with no
    # audio, silently, until the container was replaced. This happened on
    # 2026-10-16 to the one voice a paying customer had chosen for all nine of
    # her conversions. Re-synthesising on an empty entry lets it self-heal.
    # → [[preview-cache-poisoned-by-failed-synthesis]]
    if not os.path.exists(preview_path) or os.path.getsize(preview_path) == 0:
        try:
            asyncio.run(create_preview_async(voice_id, preview_path))
        except Exception:
            if os.path.exists(preview_path):
                try:
                    os.remove(preview_path)
                except OSError:
                    pass
            raise

    # Belt and braces: never answer 200 with an empty body. A caller gets a
    # real error it can surface, not silence that looks like success.
    if not os.path.exists(preview_path) or os.path.getsize(preview_path) == 0:
        return jsonify({'error': f'Preview unavailable for {voice_id}'}), 503

    return send_file(preview_path, mimetype='audio/mpeg')

# ── Public web demo (/try) ───────────────────────────────────────────────────
# Anonymous one-shot TTS for the Reddit-funnel page. Bypasses the entire
# conversion pipeline (no queue, no Supabase writes, no monthly counter).
# Streams MP3 bytes from edge-tts directly — nothing persists on disk.

DEMO_ALLOWED_VOICES = {
    # English
    'en-US-AndrewMultilingualNeural', 'en-US-EmmaMultilingualNeural',
    'en-GB-SoniaNeural', 'en-GB-RyanNeural',
    'en-US-TonyNeural', 'en-US-DavisNeural',
    # Spanish
    'es-ES-AlvaroNeural', 'es-ES-ElviraNeural',
    'es-MX-DaliaNeural', 'es-MX-JorgeNeural',
    # French
    'fr-FR-RemyMultilingualNeural', 'fr-FR-VivienneMultilingualNeural',
    'fr-CA-AntoineNeural',
    # German
    'de-DE-FlorianMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural',
    'de-AT-IngridNeural',
    # Italian
    'it-IT-GiuseppeMultilingualNeural', 'it-IT-IsabellaNeural', 'it-IT-ElsaNeural',
    # Portuguese
    'pt-BR-ThalitaMultilingualNeural', 'pt-BR-AntonioNeural', 'pt-PT-DuarteNeural',
    # Dutch
    'nl-NL-ColetteNeural', 'nl-NL-MaartenNeural', 'nl-BE-DenaNeural',
    # Polish
    'pl-PL-ZofiaNeural', 'pl-PL-MarekNeural',
    # Russian
    'ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural',
    # Chinese
    'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural',
    'zh-TW-HsiaoChenNeural',
    # Japanese
    'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
    # Korean
    'ko-KR-HyunsuMultilingualNeural', 'ko-KR-SunHiNeural', 'ko-KR-InJoonNeural',
    # Arabic
    'ar-SA-ZariyahNeural', 'ar-SA-HamedNeural',
    'ar-EG-SalmaNeural', 'ar-EG-ShakirNeural',
    # Hindi
    'hi-IN-SwaraNeural', 'hi-IN-MadhurNeural',
    # Turkish
    'tr-TR-EmelNeural', 'tr-TR-AhmetNeural',
}
DEMO_MAX_WORDS = 150  # ~1 minute of audio at 150 wpm

@app.route('/api/demo/synthesize', methods=['POST'])
def demo_synthesize():
    # Rate limit intentionally removed (2026-05-22) — funnel optimization:
    # let visitors convert as many previews as they want until we've shown
    # the free→signup conversion rate is high enough to start gating again.
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '').strip()
    voice = (data.get('voice') or '').strip()

    if not text:
        return jsonify({'error': 'missing_text'}), 400
    if voice not in DEMO_ALLOWED_VOICES:
        return jsonify({'error': 'invalid_voice'}), 400
    if len(text) > 1500:
        return jsonify({'error': 'text_too_long'}), 400
    word_count = len(text.split())
    if word_count > DEMO_MAX_WORDS:
        return jsonify({
            'error': 'word_limit',
            'message': f'Preview is limited to {DEMO_MAX_WORDS} words (~1 minute).',
            'word_count': word_count,
        }), 400

    async def _synthesize():
        audio_chunks = []
        word_events = []
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            ctype = chunk.get('type')
            if ctype == 'audio':
                audio_chunks.append(chunk['data'])
            elif ctype == 'WordBoundary':
                # edge-tts emits offsets in 100-nanosecond units
                offset_s = chunk['offset'] / 10_000_000.0
                duration_s = chunk['duration'] / 10_000_000.0
                word_events.append({
                    'word': chunk['text'],
                    'start': offset_s,
                    'end': offset_s + duration_s,
                })
        return b''.join(audio_chunks), word_events

    loop = asyncio.new_event_loop()
    try:
        audio_bytes, word_events = loop.run_until_complete(_synthesize())
    finally:
        loop.close()

    if not audio_bytes:
        return jsonify({'error': 'synthesis_failed'}), 502

    # Fallback for voices that never emit WordBoundary events. In practice
    # this hits a LOT — local probing showed en-GB-SoniaNeural, en-GB-Ryan,
    # en-US-AndrewMultilingualNeural, en-US-EmmaMultilingualNeural and
    # several others all return zero events. Without this fallback, the
    # karaoke chunks would be empty and there'd be no highlight at all.
    #
    # Two important details (both were bugs in the original implementation):
    #   1. Edge-TTS default output is 48 kbps mono MP3 → 6000 bytes/sec
    #      (NOT 3000 — the old value pegged the synthetic duration at 2x
    #      the actual audio length, causing the visible 'highlight lags
    #      behind audio by half-speed' sync issue).
    #   2. Use the production weighted distribution (long words get more
    #      time, .!? add ~500 ms pauses, etc.) via _generate_synthetic_timings,
    #      not a naive even split.
    if not word_events:
        duration_s = max(1.0, len(audio_bytes) / 6000.0)
        word_events = _generate_synthetic_timings(text, duration_s, voice_id=voice)

    # Run through the production sanitizer so the demo's binary search lands
    # on a sorted, gapless, non-overlapping, punctuation-free array — exact
    # same invariant the in-app KaraokeReader assumes.
    word_events = sanitize_word_timings(word_events)

    # Phrase-level chunks (max 3 words, but ALWAYS break at sentence-end
    # `.!?` regardless of count). Each chunk's `end` is the next chunk's
    # `start` so the trailing TTS pause (~500ms after a period, ~200ms
    # after a comma) is absorbed into the just-finished phrase's active
    # window. This is the exact same algorithm group_word_timings_into_chunks
    # uses for production audiobooks — phrase highlighting is more forgiving
    # of any per-word jitter than word-by-word highlighting.
    phrase_chunks = group_word_timings_into_chunks(word_events, max_chunk_size=3)

    duration_s = word_events[-1]['end'] if word_events else 0.0

    return jsonify({
        'audio': base64.b64encode(audio_bytes).decode('ascii'),
        'word_timings': word_events,   # kept for backwards-compat / fallback
        'chunks': phrase_chunks,        # new: phrase-level highlight units
        'duration_s': duration_s,
    })

# Front-matter chapter titles to skip so the demo lands on real prose.
_DEMO_SKIP_TITLE_PATTERNS = (
    'copyright', 'title page', 'table of contents', 'contents',
    'index', 'colophon', 'dedication', 'epigraph', 'acknowledg',
    'about the author', 'cover', 'half title', 'frontispiece',
    'praise for', 'also by', 'foreword', 'preface',
)

@app.route('/api/demo/extract-text', methods=['POST'])
@rate_limit('demo_extract')
def demo_extract_text():
    """
    Anonymous EPUB → first ~150 words of the first real chapter.
    Feeds the /try demo page so visitors can hear THEIR book's opening
    instead of a stock sample. No DB writes, no persistent storage,
    temp file deleted before return.
    """
    if 'file' not in request.files:
        return jsonify({'error': 'missing_file'}), 400
    file = request.files['file']

    try:
        validate_epub_file(file, filename=file.filename)
    except ValidationError as e:
        return jsonify({'error': 'invalid_epub', 'message': e.message}), 400

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.epub') as tmp:
            tmp_path = tmp.name
            file.save(tmp_path)

        with open(tmp_path, 'rb') as f:
            parser = SecureEpubParser(f)
            parser.validate()
            chapters = parser.extract_chapters()
            try:
                language = (parser.extract_book_language() or 'en').lower()
            except Exception:
                language = 'en'

        if not chapters:
            return jsonify({
                'error': 'no_content',
                'message': 'Could not find any text in this EPUB.',
            }), 400

        # Build a lightweight chapter list — title + word count + front-matter
        # flag only. No content, no images, no covers — keeps the response
        # tiny and rules out leaking the whole book through the demo endpoint.
        chapter_summaries = []
        chosen_index = -1
        for i, ch in enumerate(chapters):
            title = (ch.get('title') or '').strip()
            content = (ch.get('content') or '').strip()
            wc = len(content.split()) if content else 0
            is_front = any(p in title.lower() for p in _DEMO_SKIP_TITLE_PATTERNS)
            chapter_summaries.append({
                'title': title or f'Chapter {i + 1}',
                'word_count': wc,
                'is_front_matter': is_front,
            })
            if chosen_index < 0 and not is_front and wc >= 30:
                chosen_index = i

        # Fallbacks if every chapter looks like front matter (rare):
        # pick the first non-empty chapter, or just chapter 0.
        if chosen_index < 0:
            chosen_index = next(
                (i for i, c in enumerate(chapters) if (c.get('content') or '').strip()),
                0,
            )

        chosen = chapters[chosen_index]
        content = (chosen.get('content') or '').strip()
        if not content:
            return jsonify({
                'error': 'no_content',
                'message': 'This EPUB has no readable text.',
            }), 400

        words = content.split()[:DEMO_MAX_WORDS]
        return jsonify({
            'language': language,
            'chapters': chapter_summaries,
            'preview': {
                'chapter_index': chosen_index,
                'chapter_title': chosen.get('title') or f'Chapter {chosen_index + 1}',
                'text': ' '.join(words),
                'word_count': len(words),
            },
        })
    except Exception as e:
        # SECURITY: don't leak parser internals
        print(f'[DEMO-EXTRACT] Parse failed: {e}')
        return jsonify({
            'error': 'parse_failed',
            'message': 'Could not parse this EPUB file.',
        }), 400
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

@app.route('/api/voices', methods=['GET'])
def get_voices_endpoint():
    """
    Get available TTS voices.

    Optional query params:
      lang=es   — ISO 639-1 code; returns only voices whose locale starts
                  with this prefix (e.g. 'es' matches es-ES, es-MX, …).
                  Without this param all cached voices are returned.
      refresh=true — force a re-fetch from Microsoft regardless of TTL.
    """
    try:
        force_refresh = request.args.get('refresh', 'false').lower() == 'true'
        lang_filter = (request.args.get('lang') or '').strip().lower()

        vm = get_voice_manager()
        voices = asyncio.run(vm.get_voices(force_refresh=force_refresh))

        # Server-side language filter — keeps the response small and ensures
        # only voices for the requested language reach the client.
        #
        # Multilingual voices (e.g. en-US-AvaMultilingualNeural) are ALWAYS
        # included regardless of the requested language: edge-tts auto-detects
        # language per text segment for these voices, so a single one can read
        # mixed-language text (EN + AR + ZH …) in one stream. A reader whose
        # book is detected as, say, Arabic still needs to see them — they're the
        # only voices that handle the mixed-language case. Surfacing them is the
        # whole point.
        if lang_filter:
            prefix = lang_filter + '-'
            voices = [
                v for v in voices
                if (v.get('locale') or '').lower().startswith(prefix)
                or 'multilingual' in (v.get('id') or '').lower()
            ]

        frontend_voices = [
            {
                'id': voice['id'],
                'name': voice['name'],
                'description': voice['description'],
                'preview': f'/preview?voice={voice["id"]}',
                'locale': voice.get('locale'),
                'gender': voice.get('gender'),
                'status': voice.get('status', 'active'),
                'multilingual': 'multilingual' in (voice.get('id') or '').lower(),
            }
            for voice in voices
        ]

        return jsonify({
            'voices': frontend_voices,
            'count': len(frontend_voices)
        })

    except Exception as e:
        print(f"[-] Error fetching voices: {e}")
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to fetch voices'}), 500

# ── Author Pro: AI Voice Suggestion ──────────────────────────────────────────

@app.route('/suggest-voices', methods=['POST'])
@optional_auth
def suggest_voices_endpoint():
    """
    Analyze a text sample and return ranked voice suggestions.

    Body: { text: str, top_n?: int (default 3) }
    The text should be at least a few paragraphs (a full chapter is ideal).

    Returns:
    {
        suggestions: [{voice_id, match_percentage, reasons, best_for, style_description}],
        metrics: {avg_sentence_length, complexity_ratio, ...}
    }
    """
    data = request.get_json(silent=True) or {}
    text = data.get('text', '')
    top_n = min(int(data.get('top_n', 3)), 5)

    if not text or len(text.strip()) < 50:
        return jsonify({'error': 'Text too short — provide at least a paragraph'}), 400

    try:
        # Optionally cross-reference with voices we actually have available
        voice_manager = get_voice_manager()
        available = [v['id'] for v in asyncio.run(voice_manager.get_voices())]

        suggestions = suggest_voices(text, available_voice_ids=available, top_n=top_n)
        metrics = analyze_writing_style(text)
        return jsonify({'suggestions': suggestions, 'metrics': metrics}), 200
    except Exception as e:
        print(f'[ERROR] suggest_voices failed: {e}')
        return jsonify({'error': 'Failed to generate voice suggestions'}), 500


# ── Author Pro: Emotional Director Preview ────────────────────────────────────

@app.route('/analyze-emotion', methods=['POST'])
@optional_auth
def analyze_emotion_endpoint():
    """
    Detect the emotional register of a text and return the SSML prosody profile
    that would be applied. Useful for a UI "preview before converting" panel.

    Body: { text: str }

    Returns:
    {
        emotion: str,
        confidence: float,
        description: str,
        prosody: {rate, pitch, volume},
        keyword_counts: {action: N, suspense: N, ...}
    }
    """
    data = request.get_json(silent=True) or {}
    text = data.get('text', '')

    if not text or len(text.strip()) < 20:
        return jsonify({'error': 'Text too short'}), 400

    emotion, confidence, keyword_counts = detect_emotion(text)
    profile = EMOTION_PROFILES[emotion]

    return jsonify({
        'emotion': emotion,
        'confidence': confidence,
        'description': profile['description'],
        'prosody': {
            'rate': profile['rate'],
            'pitch': profile['pitch'],
            'volume': profile['volume'],
        },
        'keyword_counts': keyword_counts,
    }), 200


# ── Author Pro: Bulk emotion analysis for a chapter list ─────────────────────

@app.route('/analyze-chapters-emotion', methods=['POST'])
@require_auth
def analyze_chapters_emotion_endpoint():
    """
    Analyze detected emotions for a list of chapters before conversion.
    Lets the UI show a per-chapter emotion badge and let authors override.

    Body: { chapters: [{title, content}, ...] }
    """
    data = request.get_json(silent=True) or {}
    chapters = data.get('chapters', [])

    if not chapters:
        return jsonify({'error': 'No chapters provided'}), 400

    enriched = analyze_chapter_emotions(chapters)
    # Strip the content field from the response to keep it lean
    result = [
        {k: v for k, v in ch.items() if k != 'content'}
        for ch in enriched
    ]
    return jsonify({'chapters': result}), 200


def _extract_epub_cover_bytes(epub_path: str):
    """
    Extract the cover image from an EPUB (ZIP) file.
    Returns (image_bytes, media_type) or None.
    Tries: OPF cover-image property → EPUB2 meta cover → filename heuristic.
    """
    try:
        with zipfile.ZipFile(epub_path, 'r') as z:
            names = z.namelist()

            # Strategy 1: parse OPF manifest for cover-image
            opf_file = next((n for n in names if n.lower().endswith('.opf')), None)
            if opf_file:
                opf_content = z.read(opf_file).decode('utf-8', errors='replace')

                # EPUB3: <item ... properties="cover-image" href="...">
                m = re.search(
                    r'<item\b[^>]*\bproperties=["\'][^"\']*cover-image[^"\']*["\'][^>]*\bhref=["\']([^"\']+)["\']',
                    opf_content
                ) or re.search(
                    r'<item\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*\bproperties=["\'][^"\']*cover-image[^"\']*["\']',
                    opf_content
                )
                # EPUB2: <meta name="cover" content="ITEM_ID">
                if not m:
                    meta_m = re.search(
                        r'<meta\b[^>]*\bname=["\']cover["\'][^>]*\bcontent=["\']([^"\']+)["\']',
                        opf_content
                    )
                    if meta_m:
                        item_id = re.escape(meta_m.group(1))
                        m = re.search(
                            r'<item\b[^>]*\bid=["\']' + item_id + r'["\'][^>]*\bhref=["\']([^"\']+)["\']',
                            opf_content
                        ) or re.search(
                            r'<item\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*\bid=["\']' + item_id + r'["\']',
                            opf_content
                        )

                if m:
                    href = m.group(1).strip()
                    opf_dir = '/'.join(opf_file.split('/')[:-1])
                    candidate = f"{opf_dir}/{href}" if opf_dir else href
                    candidate = candidate.replace('./', '').lstrip('/')
                    match_name = next(
                        (n for n in names if n.lower() == candidate.lower()
                         or n.lower().endswith('/' + href.lstrip('/').lower())),
                        None
                    )
                    if match_name:
                        data = z.read(match_name)
                        mt = 'image/png' if match_name.lower().endswith('.png') else 'image/jpeg'
                        return data, mt

            # Strategy 2: any file named cover.* in an image folder
            for name in names:
                lower = name.lower()
                base = lower.split('/')[-1]
                if base.startswith('cover') and any(base.endswith(ext) for ext in ('.jpg', '.jpeg', '.png', '.webp')):
                    data = z.read(name)
                    mt = 'image/png' if lower.endswith('.png') else 'image/jpeg'
                    return data, mt

    except Exception as e:
        print(f'[INFO] _extract_epub_cover_bytes: {e}')
    return None


def _extract_chapters_from_epub_path(tmp_path):
    """Shared EPUB → {chapters, coverUrl, language, imageUploadId} extraction.

    Used by both /extract-chapters (user-uploaded file) and /extract-gutenberg
    (server-fetched public-domain EPUB) so the two ingestion paths share one
    proven extraction + image/cover pipeline. The caller owns `tmp_path` and is
    responsible for deleting it. Raises on failure.
    """
    # SECURITY: Use secure EPUB parser — keep parser open while uploading images
    with open(tmp_path, 'rb') as f:
        parser = SecureEpubParser(f)
        parser.validate()
        chapters = parser.extract_chapters()
        book_language = parser.extract_book_language()

        # Collect inline image data while the parser (ZIP) is still open,
        # then hand off to a background thread so extraction returns
        # immediately without blocking on Cloudinary uploads.
        _ALLOWED_IMG_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'}
        _MAX_IMAGES_PER_CHAPTER = 5
        _MAX_IMAGES_TOTAL = 30

        upload_tasks = []
        global_seen_srcs: set = set()

        for chapter in chapters:
            raw_inserts = chapter.pop('_raw_image_inserts', [])
            chapter['imageInserts'] = []   # filled in later by the worker
            chapter_count = 0

            for insert in raw_inserts:
                if len(upload_tasks) >= _MAX_IMAGES_TOTAL:
                    break
                if chapter_count >= _MAX_IMAGES_PER_CHAPTER:
                    break

                src = insert['src']
                if src in global_seen_srcs:
                    continue
                global_seen_srcs.add(src)

                abs_path = parser._normalize_content_path(src, insert['refFile'])
                ext = abs_path.rsplit('.', 1)[-1].lower() if '.' in abs_path else ''
                if ext not in _ALLOWED_IMG_EXTS:
                    continue

                img_bytes = parser.read_zip_file(abs_path)
                if not img_bytes or len(img_bytes) < 100:
                    continue

                # Use chapter 'id' (not list index) so results survive
                # chapter deletions made by the user in EbookReview.
                upload_tasks.append({
                    'chapter_id': chapter['id'],
                    'word_index': insert['wordIndex'],
                    'img_bytes': img_bytes,
                    'abs_path': abs_path,
                })
                chapter_count += 1

        # Register in cache then start the background thread
        image_upload_id: str | None = None
        if upload_tasks:
            image_upload_id = secrets.token_hex(16)
            with _image_upload_lock:
                _image_upload_cache[image_upload_id] = {
                    'status': 'pending',
                    'by_chapter_id': {},
                }
            t = threading.Thread(
                target=_bg_upload_images,
                args=(image_upload_id, upload_tasks),
                daemon=True,
            )
            t.start()
            print(f'[BG-IMG] Started upload of {len(upload_tasks)} image(s), id={image_upload_id}')

    # Try to extract cover art and upload to Cloudinary
    cover_url = None
    try:
        cover_result = _extract_epub_cover_bytes(tmp_path)
        if cover_result:
            cover_bytes, media_type = cover_result
            upload_result = cloudinary.uploader.upload(
                io.BytesIO(cover_bytes),
                resource_type='image',
                folder='audiobook_covers',
                transformation=[
                    {'width': 500, 'height': 500, 'crop': 'fill', 'gravity': 'auto'},
                    {'quality': 'auto', 'fetch_format': 'auto'},
                ]
            )
            cover_url = upload_result.get('secure_url')
            print(f'[INFO] Extracted cover art from EPUB: {cover_url}')
    except Exception as cover_err:
        print(f'[INFO] Cover extraction skipped: {cover_err}')

    return {
        'chapters': chapters,
        'coverUrl': cover_url,
        'language': book_language,
        'imageUploadId': image_upload_id,  # null when book has no images
    }


# Project Gutenberg is the only host we fetch public-domain EPUBs from. The
# client never supplies a URL — it sends a book id, we resolve it via Gutendex
# and host-check the result. This is the legal source-lock (see CLAUDE.md).
_GUTENBERG_HOSTS = {'gutenberg.org', 'www.gutenberg.org'}


def _is_gutenberg_epub_url(url):
    try:
        from urllib.parse import urlparse
        return (urlparse(url).hostname or '').lower() in _GUTENBERG_HOSTS
    except Exception:
        return False


@app.route('/extract-gutenberg', methods=['POST'])
@optional_auth
@rate_limit('extract_chapters')
def extract_gutenberg():
    """Fetch a PUBLIC-DOMAIN EPUB from Project Gutenberg by book id and extract
    chapters (same shape as /extract-chapters).

    SOURCE-LOCK (legal): the client sends only a numeric `book_id`. The EPUB is
    fetched SERVER-SIDE from a deterministic gutenberg.org path (host-checked) —
    the client can never point this at an arbitrary or copyrighted source. That
    constraint is the legal shield for the in-app library. No Gutendex: search
    comes from our own gutenberg_books table. See CLAUDE.md.
    """
    data = request.get_json(silent=True) or {}
    try:
        book_id = int(data.get('book_id'))
        if book_id <= 0:
            raise ValueError()
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid book id'}), 400

    # Fetch the EPUB straight from gutenberg.org — it lives at a deterministic
    # path. Try the standard candidates (with-images first). Every candidate is
    # on gutenberg.org, so the source stays public-domain-locked.
    candidates = [
        f'https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}-images.epub',
        f'https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.epub',
        f'https://www.gutenberg.org/ebooks/{book_id}.epub.images',
        f'https://www.gutenberg.org/ebooks/{book_id}.epub.noimages',
    ]
    size_cap = 15 * 1024 * 1024
    epub_bytes = None
    oversized_only = False
    for url in candidates:
        if not _is_gutenberg_epub_url(url):
            continue
        try:
            # Stream so the images edition of popular classics (Pride and
            # Prejudice's is ~25 MB, over the anti-abuse byte cap) is skipped
            # from its Content-Length header without downloading 25 MB just to
            # throw it away — the text-only candidate is usually well under 1 MB.
            with http_requests.get(url, timeout=60, stream=True) as r:
                if r.status_code != 200:
                    continue
                declared = int(r.headers.get('Content-Length') or 0)
                if declared > size_cap:
                    print(f'[gutenberg] {url} declares {declared // (1024 * 1024)} MB '
                          f'(> 15 MB cap) — trying next candidate')
                    oversized_only = True
                    continue
                content = b''
                for chunk in r.iter_content(chunk_size=1 << 20):
                    content += chunk
                    if len(content) > size_cap:  # missing/dishonest header
                        oversized_only = True
                        content = b''
                        break
            if len(content) <= 1024:
                continue
            epub_bytes = content
            break
        except Exception as e:
            print(f'[gutenberg] candidate fetch failed ({url}): {e}')
    if epub_bytes is None:
        if oversized_only:
            return jsonify({'error': 'This book is too large to convert.'}), 413
        return jsonify({'error': 'Could not download this book right now. Please try again.'}), 502

    with tempfile.NamedTemporaryFile(delete=False, suffix='.epub') as tmp:
        tmp_path = tmp.name
        tmp.write(epub_bytes)
    try:
        result = _extract_chapters_from_epub_path(tmp_path)
        result['bookId'] = book_id
        return jsonify(result)
    except Exception as e:
        print(f'[ERROR] Gutenberg extraction failed for book {book_id}: {e}')
        return jsonify({'error': 'Failed to extract chapters from this book.'}), 500
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# ── Self-hosted Gutenberg catalog (gutenberg_books table, migration 013) ──────
# Search is served from OUR Supabase table (populated by
# scripts/ingest_gutenberg_catalog.py from gutenberg.org's pg_catalog.csv), so
# it's fast and never depends on the flaky third-party Gutendex API.

# Display category sent by the app → a subject term to ILIKE-match.
_GUTENBERG_CATEGORY_TERMS = {
    'fiction': 'Fiction',
    'love': 'Love stories',
    'religion': 'Religion',
    'education': 'Education',
    'history': 'History',
    'adventure': 'Adventure',
    'detective': 'Detective and mystery',
    'children': 'Children',
    'poetry': 'Poetry',
    'science': 'Science',
}

_AUTHOR_YEARS_RE = re.compile(r',?\s*\d{3,4}\??\s*-\s*\d{0,4}\??\s*$')


def _gutenberg_row_to_book(row):
    """Map a gutenberg_books row to the client GutenbergBook shape. Cover + EPUB
    come from deterministic gutenberg.org paths."""
    bid = row['id']
    authors = [
        _AUTHOR_YEARS_RE.sub('', a).strip()
        for a in (row.get('authors') or '').split(';') if a.strip()
    ]
    subjects = [s.strip() for s in (row.get('subjects') or '').split(';') if s.strip()]
    languages = [lng.strip() for lng in (row.get('language') or '').split(';') if lng.strip()]
    return {
        'id': bid,
        'title': row.get('title') or 'Untitled',
        'authors': authors,
        'authorYears': None,
        'description': None,
        'subjects': subjects[:8],
        'languages': languages,
        'coverUrl': f'https://www.gutenberg.org/cache/epub/{bid}/pg{bid}.cover.medium.jpg',
        'released': row.get('issued'),
        'hasEpub': True,
    }


@app.route('/gutenberg/search', methods=['GET'])
@optional_auth
def gutenberg_search():
    """Search/browse the self-hosted public-domain catalog.

    ?q=<text>     → title/author search
    ?topic=<cat>  → browse a category (mapped to a subject ILIKE)
    Served from the gutenberg_books Supabase table — fast, always up.
    Returns {"books": [GutenbergBook, ...]}.
    """
    q = (request.args.get('q') or '').strip()
    topic = (request.args.get('topic') or '').strip().lower()
    try:
        supabase = get_supabase_client()
        query = supabase.table('gutenberg_books').select(
            'id,title,authors,language,subjects,issued')
        if q:
            query = query.ilike('search_text', f'%{q.lower()}%')
        elif topic:
            term = _GUTENBERG_CATEGORY_TERMS.get(topic, topic)
            query = query.ilike('subjects', f'%{term}%')
        result = query.order('id').limit(40).execute()
        books = [_gutenberg_row_to_book(r) for r in (result.data or [])]
        return jsonify({'books': books})
    except Exception as e:
        print(f'[gutenberg] search failed: {e}')
        return jsonify({'error': 'Could not load books right now. Please try again.', 'books': []}), 502


@app.route('/extract-chapters', methods=['POST'])
@optional_auth
@rate_limit('extract_chapters')
def extract_chapters():
    """Extract chapters from an uploaded EPUB, Word (.docx) or DAISY (.zip) file.

    All formats feed the same downstream pipeline (LanguageSelection → voice →
    /convert-chapters). .docx and DAISY support exist because many
    accessible-format titles (e.g. via BookShare) ship as Word or DAISY, not
    EPUB. EPUB stays the gold path with cover-art + inline-image follow-along;
    .docx and DAISY are text-only for now. (DAISY 4 is just EPUB 3 — the EPUB
    path already covers it; the .zip path handles DAISY 3 DTBook + DAISY 2.02.)
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    fname = (file.filename or '').lower()
    is_docx = fname.endswith('.docx')
    is_daisy = fname.endswith('.zip')

    # SECURITY: Validate file (extension-appropriate checks; all are ZIPs).
    try:
        if is_docx:
            validate_docx_file(file, filename=file.filename)
        elif is_daisy:
            validate_daisy_file(file, filename=file.filename)
        else:
            validate_epub_file(file, filename=file.filename)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    # Save uploaded file temporarily with the matching suffix.
    suffix = '.docx' if is_docx else '.zip' if is_daisy else '.epub'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
        file.save(tmp_path)

    try:
        if is_docx or is_daisy:
            # Word/DAISY documents carry no EPUB cover/spine images → null
            # those out so the response shape matches the EPUB path exactly.
            result = (extract_docx_chapters if is_docx
                      else extract_daisy_chapters)(tmp_path)
            return jsonify({
                'chapters': result['chapters'],
                'coverUrl': None,
                'language': (result.get('language') or 'en').lower(),
                'imageUploadId': None,
            })
        return jsonify(_extract_chapters_from_epub_path(tmp_path))
    except ValueError as e:
        # Empty / unreadable document — user-actionable.
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        fmt = ('Word document' if is_docx
               else 'DAISY book' if is_daisy else 'EPUB')
        print(f'[ERROR] Chapter extraction failed ({fmt}): {e}')
        return jsonify({'error': f'Failed to extract chapters from {fmt}'}), 500
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.route('/convert', methods=['POST'])
@require_auth
@rate_limit('convert')
def convert():
    """
    Legacy raw-EPUB conversion endpoint.  Kept for backward compatibility
    with old app builds; new builds use /convert-chapters which also runs
    the per-month gate.
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']

    # SECURITY: Validate file
    try:
        validate_epub_file(file, filename=file.filename)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    voice_id = request.form.get('voice', list(VOICES.values())[0])

    # SECURITY: Validate voice_id
    try:
        validate_voice_id(voice_id)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    # Run the same conversion-credit gate /convert-chapters uses. Without
    # this, legacy clients could bypass the limit by hitting this route.
    user_id = request.user_id
    profile = get_user_profile(user_id)
    if not profile:
        return jsonify({'error': 'Failed to load user profile'}), 500
    gate = _check_lifetime_conversion_gate(profile)
    if not gate['allowed']:
        return jsonify(gate['response']), gate.get('status', 403)

    # SECURITY: Generate secure task ID (timestamp + random hex)
    task_id = f"{int(time.time() * 1000)}_{secrets.token_hex(8)}"

    # Save uploaded file to a temp path before queuing
    with tempfile.NamedTemporaryFile(delete=False, suffix='.epub') as tmp:
        tmp_path = tmp.name
        file.save(tmp_path)

    enqueue_task(task_manager, task_id, {
        'progress': 0,
        'status': 'Queued — waiting to start...',
        'complete': False,
        'user_id': user_id,
        'conversion_type': 'epub',
        'epub_path': tmp_path,
        'voice_id': voice_id,
    }, get_supabase_client())

    return jsonify({'task_id': task_id})

@app.route('/convert-text', methods=['POST'])
@require_auth
@rate_limit('convert_text')
def convert_text():
    """Convert plain text to audio (for custom chapters)"""
    data = request.get_json()

    if not data or 'text' not in data:
        return jsonify({'error': 'No text provided'}), 400

    text = data['text']
    voice_id = data.get('voice', list(VOICES.values())[0])

    # SECURITY: Validate and sanitize text
    try:
        text = validate_text_content(text)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    # SECURITY: Validate voice_id
    try:
        validate_voice_id(voice_id)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    # Same conversion-credit gate as /convert-chapters.
    user_id = request.user_id
    profile = get_user_profile(user_id)
    if not profile:
        return jsonify({'error': 'Failed to load user profile'}), 500
    gate = _check_lifetime_conversion_gate(profile)
    if not gate['allowed']:
        return jsonify(gate['response']), gate.get('status', 403)

    # SECURITY: Generate secure task ID
    task_id = f"{int(time.time() * 1000)}_{secrets.token_hex(8)}"

    enqueue_task(task_manager, task_id, {
        'progress': 0,
        'status': 'Queued — waiting to start...',
        'complete': False,
        'user_id': user_id,
        'conversion_type': 'text',
        'text_content': text,
        'voice_id': voice_id,
    }, get_supabase_client())

    return jsonify({'task_id': task_id})

# Max total words accepted for one conversion. The synthesis pipeline holds
# every chapter's word-timings in memory until the final DB save, so peak memory
# scales with total size — a ~2.7M-word upload OOM-crash-looped the 512MB Render
# worker (May 2026). Reject oversized books up front so one giant upload can't
# take the service down. Raise this (env override) when the instance gets more RAM.
MAX_CONVERSION_WORDS = int(os.environ.get('MAX_CONVERSION_WORDS', '500000'))

# ── Conversion throughput prior — the ETA before the first chapter lands ────
# Until a chapter completes, the worker had no measured rate and published no
# eta_seconds at all, so the client fell back to its own guess of 250 words
# per minute — i.e. "conversion runs at reading speed". It doesn't: whole-book
# throughput measured across 2026-09-11 → 09-14 ran 7× realtime for a
# single-chapter book (no chapter parallelism) and ~28× for multi-chapter
# ones. A tester saw "about 5 hours remaining" on a 30-chapter book that took
# 48 minutes. The seed below is the *slowest* measured whole-book rate, so a
# first estimate errs pessimistic by a little rather than by 6×; once real
# tasks complete on this instance the median of their measured rates takes
# over. In-memory on purpose — a deploy resets it to the seed, which is fine.
import collections as _collections
import statistics as _statistics
_ETA_SEED_WORDS_PER_SEC = 18.0          # ≈7× realtime at 150 wpm (words / wall-second)
_recent_task_rates: '_collections.deque[float]' = _collections.deque(maxlen=10)
_rates_lock = threading.Lock()


def _estimated_words_per_sec() -> float:
    with _rates_lock:
        if _recent_task_rates:
            return float(_statistics.median(_recent_task_rates))
    return _ETA_SEED_WORDS_PER_SEC


def _record_task_rate(total_words: int, elapsed_s: float) -> None:
    """Feed a completed task's measured throughput into the ETA prior."""
    if elapsed_s <= 0 or total_words <= 0:
        return
    rate = total_words / elapsed_s
    # Ignore absurd values (a cached re-run finishing in seconds would make
    # the next honest estimate look instant).
    if not (2.0 <= rate <= 200.0):
        return
    with _rates_lock:
        _recent_task_rates.append(rate)
    print(f"  📈 Throughput: {rate:.1f} words/s — ETA prior now {_estimated_words_per_sec():.1f} words/s")

# How far a playback position may move BACKWARDS within a single chapter before
# /api/audiobooks/<id>/progress treats it as client drift rather than listening.
# Must comfortably exceed the in-app rewind (15s) and the lock-screen nudge (30s)
# so an un-flagged double-tap is never mistaken for a bug. See the guard in
# update_progress for why this exists.
PROGRESS_REGRESSION_TOLERANCE_S = int(os.environ.get('PROGRESS_REGRESSION_TOLERANCE_S', '90'))


@app.route('/convert-chapters', methods=['POST'])
@optional_auth
def convert_chapters_endpoint():
    """
    Convert multiple chapters to audio.

    Accepts EITHER authenticated requests (Bearer JWT, billed against the
    user's monthly conversion quota with source-hash dedup) OR anonymous
    requests with an X-Device-Id header (one lifetime conversion per device,
    no monthly accounting). The branch happens after gate selection — task
    enqueue, worker, and save paths all carry the chosen identity through.
    """
    user_id = request.user_id
    device_id = request.device_id
    data = request.get_json()

    if not data or 'chapters' not in data:
        return jsonify({'error': 'No chapters provided'}), 400

    if not user_id and not device_id:
        # Neither identity present — refuse rather than silently produce an
        # orphan task that the worker can't attribute.
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

    supabase = get_supabase_client()

    # source_hash is sent by the new mobile build (SHA-256 of first 64KB of
    # EPUB). Authenticated retry dedup uses it; anonymous trials don't (one
    # lifetime conversion regardless of hash).
    source_hash = data.get('source_hash')

    if user_id:
        profile = get_user_profile(user_id)
        if not profile:
            return jsonify({'error': 'Failed to load user profile'}), 500

        # Lifetime successful-conversion gate (June 2026 v2): free 2 / starter 10
        # / pro unlimited (tier_limits.py). Counter = profiles.conversion_count,
        # incremented only on completion below. Replaced the library-size gate.
        gate = _check_lifetime_conversion_gate(profile)
        if not gate['allowed']:
            # Gates return 403 by default, but 503 when the refusal is an
            # infrastructure failure rather than a real denial — see
            # _check_anonymous_conversion_gate.
            return jsonify(gate['response']), gate.get('status', 403)
        is_retry = False  # source-hash retry-dedup retired with the monthly gate
    else:
        # Anonymous trial: row-existence check against device_id. One lifetime
        # conversion per device. No profile row, no monthly counter.
        profile = None
        gate = _check_anonymous_conversion_gate(supabase, device_id)
        if not gate['allowed']:
            # Gates return 403 by default, but 503 when the refusal is an
            # infrastructure failure rather than a real denial — see
            # _check_anonymous_conversion_gate.
            return jsonify(gate['response']), gate.get('status', 403)
        is_retry = False

    chapters = data['chapters']
    voice_id = data.get('voice', list(VOICES.values())[0])
    ebook_title = data.get('title', 'Untitled Audiobook')
    cover_url = data.get('cover_url')
    # SECURITY: Only allow Cloudinary-hosted cover images
    if cover_url and not cover_url.startswith('https://res.cloudinary.com/'):
        cover_url = None
    # Author Pro feature flags (default False for backward compat)
    use_emotional_director = bool(data.get('use_emotional_director', False))
    generate_word_timings = bool(data.get('generate_word_timings', True))
    # ISO 639-1 book language (e.g. "en", "es") — None for old app builds that
    # don't send it. Persisted on the audiobook row for library filtering.
    language = data.get('language')
    if language:
        language = str(language).strip().lower() or None
    # Token referencing the background image upload started by /extract-chapters.
    # None means the book had no inline images.
    image_upload_id = data.get('image_upload_id') or None

    # SECURITY: Validate voice_id
    try:
        validate_voice_id(voice_id)
    except ValidationError as e:
        return jsonify({'error': e.message}), 400

    if not chapters or len(chapters) == 0:
        return jsonify({'error': 'Chapters array is empty'}), 400

    # Per-book word caps, checked before the task is queued so an oversized
    # upload can't OOM the worker. Two layers:
    #   1. The tier's max_conversion_words (free 100k / starter 200k /
    #      pro+lifetime uncapped) — long books are the paid luxury.
    #      Anonymous trials get the free tier's cap.
    #   2. MAX_CONVERSION_WORDS — the hard infra ceiling for everyone.
    total_words = sum(len((ch.get('content') or '').split()) for ch in chapters)

    from tier_limits import limits_for, cheapest_tier_for_words, TIER_LIMITS
    tier = (profile or {}).get('subscription_tier', 'free')
    tier_cap = limits_for(tier).get('max_conversion_words')
    if tier_cap is not None and total_words > tier_cap:
        # Name the *cheapest* tier that actually clears this book, and
        # pre-select it on the paywall. A generic "upgrade" leaves the user
        # guessing: on 2026-08-21 someone with a 195k-word book (which fits
        # starter's 200k cap) picked pro, saw that price and abandoned.
        #
        # Deliberately no "split the book into parts" suggestion. It used to
        # sit in this same sentence, and it's the path of least resistance at
        # the exact moment we're asking for money — that user split the book
        # by hand instead of subscribing, burning two credits and producing a
        # broken half. Signing up is NOT offered here either: anonymous and
        # free share the same word cap, so it would be a false promise (the
        # signup prompt belongs on the conversion-credit gate, where it's
        # genuinely an upgrade).
        suggested = cheapest_tier_for_words(
            total_words, tier, infra_ceiling=MAX_CONVERSION_WORDS
        )
        if suggested:
            suggested_cap = TIER_LIMITS[suggested].get('max_conversion_words')
            if suggested_cap is None:
                offer = (
                    f'{suggested.title()} converts books of any length.'
                )
            else:
                offer = (
                    f'{suggested.title()} converts books up to '
                    f'{suggested_cap:,} words.'
                )
            message = (
                f'This book is about {total_words:,} words, and your plan '
                f'converts books up to {tier_cap:,} words. {offer}'
            )
        else:
            # Nothing on the ladder clears it — this is the infra ceiling,
            # so don't dangle an upgrade that wouldn't work either.
            message = (
                f'This book is about {total_words:,} words, which is longer '
                f'than we can convert in one go.'
            )
        return jsonify({
            'error': message,
            'too_large': True,
            'tier_word_limit': True,
            'word_count': total_words,
            'max_words': tier_cap,
            'suggested_tier': suggested,
            'suggested_tier_max_words': (
                TIER_LIMITS[suggested].get('max_conversion_words')
                if suggested else None
            ),
        }), 413

    if total_words > MAX_CONVERSION_WORDS:
        return jsonify({
            'error': (
                f'Your book has about {total_words:,} words, but the most we can '
                f'convert right now is {MAX_CONVERSION_WORDS:,} words (about a very '
                'long novel). This limit is about the number of words, not the file '
                'size — even a small file can hold a lot of text. You can split the '
                'book into parts and convert each part separately.'
            ),
            'too_large': True,
            'word_count': total_words,
            'max_words': MAX_CONVERSION_WORDS,
        }), 413

    # SECURITY: Generate secure task ID
    task_id = f"{int(time.time() * 1000)}_{secrets.token_hex(8)}"

    # Store input chapters in the task so the queue worker can retrieve them.
    # process_chapters_conversion will overwrite 'chapters' with the output
    # (converted chapters with audioUrl) when complete.
    # is_retry tells the worker not to increment the monthly counter.
    # Exactly one identity column set per CHECK constraint in migration 010.
    # `None` values are stripped by task_manager.create_task so the row
    # respects the (user_id XOR device_id) constraint.
    enqueue_task(task_manager, task_id, {
        'progress': 0,
        'status': 'Queued — waiting to start...',
        'complete': False,
        'chapters': chapters,
        'user_id': user_id,
        'device_id': device_id if not user_id else None,
        'title': ebook_title,
        'cover_url': cover_url,
        'conversion_type': 'chapters',
        'voice_id': voice_id,
        'use_emotional_director': use_emotional_director,
        'generate_word_timings': generate_word_timings,
        'source_hash': source_hash,
        'is_retry': is_retry,
        'language': language,
        'image_upload_id': image_upload_id,
    }, get_supabase_client())

    return jsonify({'task_id': task_id})


def _check_anonymous_conversion_gate(supabase, device_id):
    """
    Anonymous-trial gate: returns allowed=True if this device has never
    completed a conversion (no audiobook row with this device_id), else
    allowed=False with a body the frontend can route to AnonymousLimitModal.

    No monthly accounting, no profile row, no source-hash dedup — the trial
    is strictly 1 lifetime per device.
    """
    try:
        existing = supabase.table('audiobooks') \
            .select('id', count='exact') \
            .eq('device_id', device_id) \
            .limit(1) \
            .execute()
        if (existing.count or 0) > 0:
            return {
                'allowed': False,
                'response': {
                    'error': "You've used your trial conversion. Sign up to convert more books and keep them forever.",
                    'anonymous_limit_reached': True,
                },
            }
    except Exception as e:
        err = str(e).lower()
        # Two very different failures arrive through this one `except`, and
        # conflating them cost us real users during the Aug-Sep 2026 outage:
        # an anonymous user reached Convert and was told "please sign up" —
        # a permanent-sounding 403, blaming their account status for our
        # downtime, and pointing at a signup that was equally broken because
        # `profiles` could not be written either.
        #
        #   * The column genuinely isn't there (migration 010 not run) —
        #     structural and permanent. Fail closed: refusing is correct,
        #     because letting anonymous conversions through unchecked is the
        #     bypass this gate exists to prevent.
        #
        #   * Anything else (DNS, timeout, connection reset, 5xx, project
        #     paused) — transient. The honest answer is 503: we are down, it
        #     is not you, try again. Never upsell here.
        structural = (
            '42703' in err
            or 'schema cache' in err
            or ('device_id' in err and 'column' in err)
        )
        if structural:
            print(f'[gate] device_id column missing — failing closed: {e}')
            return {
                'allowed': False,
                'response': {
                    'error': 'Anonymous trial temporarily unavailable. Please sign up to continue.',
                    'anonymous_unavailable': True,
                },
            }

        print(f'[gate] anonymous device_id lookup failed (transient): {e}')
        return {
            'allowed': False,
            'status': 503,
            'response': {
                'error': "We're having trouble reaching our servers right now. "
                         "This isn't a problem with your account — please try again shortly.",
                'service_unavailable': True,
                'retryable': True,
            },
        }
    return {'allowed': True, 'is_retry': False}


def _check_lifetime_conversion_gate(profile):
    """Conversion-credit gate (June 2026 v3 — the only paid gate).

    The allowance ACCRUES over time (tier_limits.conversion_allowance:
    starter credits + monthly accrual × account age — free 3+1/mo,
    starter 10+10/mo, pro/lifetime/enterprise unlimited); the count is the
    lifetime `profiles.conversion_count`, which increments only when a
    conversion completes and never decreases (deleting a book does NOT
    refund a credit). `None` allowance = unlimited.

    Returns {'allowed': True} or {'allowed': False, 'response': <json dict>}.
    """
    from tier_limits import conversion_allowance
    tier = profile.get('subscription_tier', 'free')
    allowance = conversion_allowance(tier, profile.get('created_at'))
    if allowance is None:
        return {'allowed': True}
    used = profile.get('conversion_count', 0) or 0
    if used >= allowance:
        return {
            'allowed': False,
            'response': {
                'error': (
                    "You've used all your conversion credits for now. "
                    "You earn a new credit each month, or upgrade to "
                    "convert more books right away."
                ),
                'limit_reached': True,
                'lifetime_limit_reached': True,
                'conversion_count': used,
                # Field name kept for app-binary compatibility; the value is
                # the CURRENT accrued allowance, which grows monthly.
                'max_lifetime_conversions': allowance,
            },
        }
    return {'allowed': True}


def process_chapters_conversion(
    task_id,
    chapters,
    voice_id,
    use_emotional_director=False,
    generate_word_timings=True,
    cancel_check=None,
):
    """
    Process conversion of multiple chapters in parallel.

    Up to PARALLEL_CHAPTER_WORKERS chapters are converted concurrently.
    Each worker streams Edge TTS audio, captures WordBoundary timings,
    groups them into 3-word karaoke chunks, and uploads to Cloudinary.
    Results are collected in chapter order for storage.
    """
    from queue_manager import TaskCancelledError, _fmt_duration

    # Concurrent CHAPTERS, not streams. Total edge-tts streams =
    # PARALLEL_CHAPTER_WORKERS × the chunk semaphore in word_timing.py
    # (currently 1), so 2 streams system-wide. Keep that product at 2:
    # above it Microsoft returns NoAudioReceived and chapters are lost
    # silently → [[edge-tts-throttle-silent-chapter-loss]].
    PARALLEL_CHAPTER_WORKERS = 2

    converted_chapters = []
    total_chapters = len(chapters)
    conversion_start = time.time()

    # Thread-safe progress counters
    completed_lock = threading.Lock()
    completed_count = [0]

    # Diagnostic: dump per-chapter content size before we start. There's a
    # rare bug where word counts come back as [1, 1, 1, …] even though the
    # task row in the DB has full chapter content — suggesting `chapters`
    # arriving at the worker is somehow different from what's persisted.
    # Logging the full picture so we can catch it in action next time.
    print(f"\n  ▶ Chapter diagnostics for task {task_id}:")
    for ci, ch in enumerate(chapters[:5]):  # first 5 only, full dump too noisy
        content = ch.get('content')
        clen = len(content) if isinstance(content, str) else 0
        print(f"    [{ci}] id={ch.get('id')!r} title={(ch.get('title') or '')[:40]!r} "
              f"content_type={type(content).__name__} content_len={clen}")

    # Word-weighted progress: pre-compute each chapter's word count so the
    # progress bar reflects actual content size, not just chapter count.
    # A 10,000-word chapter moves the bar 10x more than a 1,000-word chapter.
    chapter_word_counts = [max(1, len(ch.get('content', '').split())) for ch in chapters]
    total_words = max(1, sum(chapter_word_counts))
    completed_words = [0]  # words from fully-finished chapters (protected by completed_lock)

    # Defensive guard: if a task arrives with effectively no content across
    # ALL chapters (e.g. word_counts = [1, 1, 1, …]) we've previously wasted
    # ~30 s of Cloudinary uploads producing a useless audiobook. Fail fast
    # instead with a clear error so the user (and the logs) know what went
    # wrong, and the orphan-cleanup script can reap the chunks.
    total_content_chars = sum(
        len(ch.get('content') or '') for ch in chapters
    )
    if total_chapters >= 3 and total_content_chars < total_chapters * 50:
        msg = (
            f'Task {task_id} arrived with effectively empty chapter content '
            f'({total_content_chars} chars across {total_chapters} chapters). '
            f'Refusing to synthesize. First chapter dump: '
            f'{chapters[0] if chapters else "(empty)"!r}'
        )
        print(f"  [!] {msg}")
        raise ValueError(msg)

    # Running list of per-chapter elapsed times (seconds) for ETA calculation.
    # Only appended in the main as_completed loop, so no locking needed.
    chapter_times: list = []

    print(f"\n  ▶ {total_chapters} chapter(s)  |  {PARALLEL_CHAPTER_WORKERS} parallel workers\n")
    print(f"  ▶ Total words: {total_words:,}  |  word counts: {chapter_word_counts}\n")

    # Publish an estimate immediately, from the measured prior — before this,
    # eta_seconds was absent until chapter 1 finished (1–4 min) and the client
    # showed its 250-words-per-minute guess.
    task_manager.update_task(task_id, {
        'status': f'Synthesizing chapter 1/{total_chapters}...',
        'progress': 0,
        'eta_seconds': int(total_words / _estimated_words_per_sec()),
    })

    def _do_chapter(idx, chapter):
        """Convert one chapter; returns (idx, chapter_entry) or raises."""
        chapter_num = idx + 1
        chapter_start = time.time()

        if cancel_check and cancel_check():
            raise TaskCancelledError()

        text = chapter.get('content', '')
        if not text.strip():
            return idx, None, 0.0

        print(f"  [{chapter_num}/{total_chapters}] ▶ START  {chapter.get('title', f'Chapter {chapter_num}')!r}")
        # Push status to frontend so it shows which chapter is being synthesized now.
        # With parallel workers this will reflect one of the currently-running chapters.
        task_manager.update_task(task_id, {'status': f'Synthesizing chapter {chapter_num}/{total_chapters}...'})
        audio_path = os.path.join(tempfile.gettempdir(), f'chapter_{task_id}_{chapter_num}.mp3')

        # Heartbeat thread — fires every 30 s while this chapter is synthesising.
        # It does two important things that the per-chapter completion update
        # can't do alone:
        #
        # 1. Bumps `started_at` so the Supabase requeue_stuck_tasks RPC doesn't
        #    flip an actively-running task back to 'queued'. updated_at refreshes
        #    on every column write, but the recovery function checks started_at
        #    — so we have to explicitly stamp that too. Without this, a long
        #    chapter (3-5 min for 7000+ words) triggers the 2-min stuck sweep,
        #    queue_status flips to 'queued', and the frontend shows "in queue"
        #    even though synthesis is still actively running in the background.
        #
        # 2. Updates eta_seconds using a word-rate formula instead of the
        #    avg-chapter-time approach used at chapter-completion. With
        #    avg-chapter-time, the ETA was both wobbly (jumps UP when a long
        #    chapter completes and pulls the average up) and stale (never
        #    updates mid-chapter). The word-rate is smoother and refreshes
        #    every 30s so the countdown actually counts down.
        # Watchdog: if ONE chapter has been synthesising this long, the
        # edge-tts stream is wedged (one production task heartbeated
        # for 8+ h on a hung chapter and the stuck sweep never fired, because
        # the heartbeat kept bumping started_at). The largest legitimate
        # chapters take 3–10 min; past this cap we stop the heartbeat so
        # started_at goes stale and requeue_stuck_tasks can recover the task
        # (the requeue retry cap prevents an infinite requeue loop).
        CHAPTER_HEARTBEAT_MAX_S = 30 * 60
        heartbeat_started = time.time()
        stop_heartbeat = threading.Event()
        def _heartbeat():
            while not stop_heartbeat.wait(30):
                if time.time() - heartbeat_started > CHAPTER_HEARTBEAT_MAX_S:
                    print(f"[WARN] chapter {chapter_num}/{total_chapters} of task {task_id} "
                          f"still synthesising after {CHAPTER_HEARTBEAT_MAX_S // 60} min — "
                          f"assuming wedged; stopping heartbeat so the stuck sweep can requeue")
                    return
                try:
                    with completed_lock:
                        cw = completed_words[0]
                    elapsed = time.time() - conversion_start
                    update = {
                        'status': f'Synthesizing chapter {chapter_num}/{total_chapters}...',
                        'started_at': datetime.now(dt_timezone.utc).isoformat(),
                    }
                    if elapsed > 5 and cw > 0:
                        rate = cw / elapsed   # words/sec across all parallel workers
                        remaining_words = max(0, total_words - cw)
                        if rate > 0:
                            update['eta_seconds'] = int(remaining_words / rate)
                        update['progress'] = min(int(cw / total_words * 90), 89)
                    task_manager.update_task(task_id, update)
                except Exception:
                    pass  # heartbeat is best-effort; never crash the conversion
        heartbeat_thread = threading.Thread(target=_heartbeat, daemon=True)
        heartbeat_thread.start()

        this_chapter_words = chapter_word_counts[idx]

        def _chapter_progress(fraction, _ch_num=chapter_num, _ch_words=this_chapter_words):
            """Called every ~50 words to push live within-chapter progress.
            Uses word-weighted formula so a 10k-word chapter moves the bar
            proportionally more than a 500-word chapter."""
            with completed_lock:
                done = completed_count[0]
                cw = completed_words[0]
            words_so_far = cw + int(_ch_words * fraction)
            overall_pct = min(int(words_so_far / total_words * 90), 89)
            pct_display = int(fraction * 100)
            task_manager.update_task(task_id, {
                'status': (
                    f'{done}/{total_chapters} chapters done — '
                    f'synthesizing chapter {_ch_num}/{total_chapters} ({pct_display}% of chapter)...'
                ) if done > 0 else (
                    f'Synthesizing chapter {_ch_num}/{total_chapters} ({pct_display}% of chapter)...'
                ),
                'progress': overall_pct,
            })

        try:
            word_timings = None
            detected_emotion = None

            if generate_word_timings or use_emotional_director:
                word_timings, detected_emotion = create_chapter_audio_with_timings(
                    text,
                    audio_path,
                    voice_id,
                    use_emotional_director=use_emotional_director,
                    progress_callback=_chapter_progress,
                )
                wt_count = len(word_timings) if word_timings else 0
                print(f"[word_timing] Chapter {chapter_num}: {wt_count} word timings, voice={voice_id}")
            else:
                create_audiobook(text, audio_path, voice_id, progress_callback=_chapter_progress)

            if not os.path.exists(audio_path):
                raise IOError(f"Audio file for chapter {chapter_num} was not generated")

            # Upload to Cloudinary
            print(f"  [{chapter_num}/{total_chapters}] ↑ Uploading to Cloudinary...")
            upload_result = cloudinary.uploader.upload(audio_path, resource_type="video")
            audio_duration = upload_result.get('duration', 0)

            # Synthetic fallback when voice didn't emit WordBoundary events
            if (generate_word_timings or use_emotional_director) and not word_timings and text.strip():
                word_timings = _generate_synthetic_timings(text, audio_duration, voice_id=voice_id)
                # Sanitise even the synthetic path so the karaoke binary
                # search sees a monotonic, gap-free array regardless of which
                # generator produced it.
                word_timings = sanitize_word_timings(word_timings)
                print(f"[word_timing] Chapter {chapter_num}: synthetic fallback — {len(word_timings)} words")

            # Store raw word-level timings so the frontend can group them
            # dynamically based on the user's highlight preference (1 word or 3).
            if word_timings:
                print(f"[word_timing] Chapter {chapter_num}: {len(word_timings)} word-level timings stored")

            chapter_elapsed = time.time() - chapter_start
            total_elapsed = time.time() - conversion_start
            print(f"  [{chapter_num}/{total_chapters}] Done in {_fmt_duration(chapter_elapsed)} "
                  f"({audio_duration:.0f}s audio)  |  total: {_fmt_duration(total_elapsed)}")

            return idx, {
                'id': chapter.get('id', str(chapter_num)),
                'title': chapter.get('title', f'Chapter {chapter_num}'),
                'audioUrl': upload_result['secure_url'],
                'duration': audio_duration,
                'position': idx,
                'word_timings': word_timings,
                'detected_emotion': detected_emotion,
                'imageInserts': chapter.get('imageInserts', []),
            }, chapter_elapsed
        except TaskCancelledError:
            raise
        except Exception as e:
            print(f"  [{chapter_num}/{total_chapters}] ERROR: {e}")
            return idx, None, time.time() - chapter_start
        finally:
            # Stop the per-chapter heartbeat thread cleanly.
            stop_heartbeat.set()
            heartbeat_thread.join(timeout=1)
            if os.path.exists(audio_path):
                os.unlink(audio_path)

    results: dict = {}

    try:
        with ThreadPoolExecutor(max_workers=PARALLEL_CHAPTER_WORKERS) as executor:
            futures = {
                executor.submit(_do_chapter, idx, chapter): idx
                for idx, chapter in enumerate(chapters)
            }
            for future in as_completed(futures):
                if cancel_check and cancel_check():
                    raise TaskCancelledError()

                try:
                    idx, chapter_entry, chapter_elapsed = future.result()
                except TaskCancelledError:
                    raise
                except Exception as e:
                    idx = futures[future]
                    print(f"  Chapter {idx + 1} unhandled error: {e}")
                    chapter_entry = None
                    chapter_elapsed = 0.0

                if chapter_entry is not None:
                    results[idx] = chapter_entry

                if chapter_elapsed > 0:
                    chapter_times.append(chapter_elapsed)

                with completed_lock:
                    completed_count[0] += 1
                    completed_words[0] += chapter_word_counts[idx]
                    done = completed_count[0]
                    cw = completed_words[0]

                remaining = total_chapters - done
                # Word-weighted overall progress (capped at 90 — final 10% for DB save/upload)
                overall_pct = min(int(cw / total_words * 90), 90)
                task_update: dict = {
                    'status': f'{done}/{total_chapters} chapters done...' if remaining > 0 else 'Finalising...',
                    'progress': overall_pct,
                    # Refresh started_at on every chapter completion too, so the
                    # requeue sweep doesn't false-positive on this active task
                    # between heartbeat ticks.
                    'started_at': datetime.now(dt_timezone.utc).isoformat(),
                }
                # ETA: word-rate based on actual wall-clock throughput.
                # words_per_sec = completed_words / elapsed_so_far → smooth,
                # naturally accounts for parallelism, doesn't wobble like the
                # old chapter-avg-time formula did when chapters of wildly
                # different sizes completed.
                elapsed_so_far = time.time() - conversion_start
                if remaining > 0 and elapsed_so_far > 5 and cw > 0:
                    rate = cw / elapsed_so_far
                    remaining_words = max(0, total_words - cw)
                    eta_seconds = int(remaining_words / rate) if rate > 0 else 0
                    task_update['eta_seconds'] = eta_seconds
                    eta_display = f"  |  ~{_fmt_duration(eta_seconds)} remaining"
                else:
                    eta_display = ""
                task_manager.update_task(task_id, task_update)
                print(f"  📊 Progress: {done}/{total_chapters} complete{eta_display}")

        # Reassemble chapters in original order (parallel completion is unordered)
        converted_chapters = [results[i] for i in range(len(chapters)) if i in results]
        _record_task_rate(total_words, time.time() - conversion_start)

        # Final cancellation check before saving anything
        if cancel_check and cancel_check():
            raise TaskCancelledError()

        # How many chapters SHOULD have produced audio?  Not len(chapters):
        # _do_chapter legitimately returns None for a chapter whose content is
        # blank after strip() (section dividers, empty pages), and those never
        # enter `results`.  Counting them as losses would flag healthy books as
        # failed, which is worse than the bug being fixed here.  So the
        # denominator is the chapters that were actually attempted.
        attempted_count = sum(1 for ch in chapters if (ch.get('content') or '').strip())
        missing_count = attempted_count - len(converted_chapters)

        # A conversion that lost chapters must NEVER report a bare success.
        #
        # Before 2026-10-16 this wrote complete=True unconditionally, so when
        # Microsoft refused 52 of one customer's 77 chapters, the 25 survivors
        # saved fine, no exception was raised, no error was ever set, and the
        # task ended complete=True / error=None / progress=100 / 'Complete!'.
        # She was pushed "Audiobook Ready" for a book missing two thirds of
        # itself.  A non-empty check would not have caught it — 25 is non-empty
        # — so the test has to be against the attempted count.
        #
        # `error` is the signalling mechanism on purpose: handleCompletion() in
        # ConversionContext.tsx checks serverTask.error FIRST and fires
        # conversion_failed before ever reaching the success path, so the build
        # already in users' hands does the right thing with no app update
        # (build 40 was never released).  The successful chapters are still
        # saved to Supabase by the save block below — the book is labelled
        # honestly, not thrown away.
        #
        # Both keys go in ONE update_task call.  Today's false success happened
        # because complete=True landed ~476 ms before error, and a client poll
        # inside that window saw an unqualified success and stopped polling.
        # A single write leaves no such window.
        # → [[edge-tts-throttle-silent-chapter-loss]]
        completion_update: dict = {
            'status': 'Complete!',
            'progress': 100,
            'complete': True,
            'chapters': converted_chapters,
        }
        if missing_count > 0:
            completion_update['status'] = (
                f'Converted {len(converted_chapters)} of {attempted_count} chapters'
            )
            # Shown verbatim to the user by ConversionScreen.tsx — plain
            # English, says whose fault it is, and gives them an action.
            completion_update['error'] = (
                f'Only {len(converted_chapters)} of {attempted_count} chapters could be '
                f'converted. Nothing is wrong with your book or your account — the '
                f'text-to-speech service refused the rest. The chapters that did '
                f'convert are saved in your library. Please try converting again.'
            )
            print(f"\n  ⚠  PARTIAL CONVERSION: {len(converted_chapters)}/{attempted_count} "
                  f"chapters produced audio — {missing_count} refused or errored.")
            print(f"     Task {task_id} is marked complete WITH an error so the client "
                  f"reports it as failed rather than ready.\n")

        task_manager.update_task(task_id, completion_update)

        # Save to database
        task = task_manager.get_task(task_id)
        user_id = task.get('user_id')
        device_id = task.get('device_id')
        ebook_title = task.get('title', 'Untitled Audiobook')
        cover_url = task.get('cover_url')
        source_hash = task.get('source_hash')
        is_retry = bool(task.get('is_retry'))
        language = task.get('language')
        image_upload_id = task.get('image_upload_id')

        # If background image uploads are still running, wait up to 90 s.
        # The ConversionScreen shows the task status string, so the user sees
        # "📸 Uploading your book's images..." in the progress area.
        if image_upload_id:
            wait_start = time.time()
            while time.time() - wait_start < 90:
                with _image_upload_lock:
                    img_status = _image_upload_cache.get(image_upload_id, {}).get('status')
                if img_status == 'done':
                    break
                if img_status is None:   # cache gone (e.g. server restart)
                    image_upload_id = None
                    break
                task_manager.update_task(task_id, {
                    'status': '📸 Uploading your book\'s images...',
                    'progress': 5,
                })
                time.sleep(3)

        # Merge image upload results into converted_chapters before DB save.
        if image_upload_id:
            with _image_upload_lock:
                img_entry = _image_upload_cache.pop(image_upload_id, {})
            images_by_chapter_id = img_entry.get('by_chapter_id', {})
            if images_by_chapter_id:
                for ch in converted_chapters:
                    inserts = images_by_chapter_id.get(str(ch.get('id', '')))
                    if inserts:
                        ch['imageInserts'] = inserts

        if user_id or device_id:
            db_save_ok = False
            try:
                # Insert audiobook record. Exactly one of user_id / device_id
                # is set (CHECK constraint chk_audiobooks_identity in migration 010).
                audiobook_data = {
                    'title': ebook_title,
                    'voice_id': voice_id,
                    'voice_name': get_voice_name(voice_id),
                    'status': 'completed',
                    'progress': 0,
                    'current_position': 0,
                    'current_chapter': 0,
                    'duration': 0,
                    'is_custom': True,
                    'cover_url': cover_url,
                }
                if user_id:
                    audiobook_data['user_id'] = user_id
                else:
                    audiobook_data['device_id'] = device_id
                if source_hash:
                    audiobook_data['source_hash'] = source_hash
                if language:
                    audiobook_data['language'] = language

                supabase = get_supabase_client()
                # Defensive insert: retry-without-column on PostgREST schema-cache
                # errors so the backend stays alive when migration 005 (language)
                # or 001 (source_hash) hasn't been applied yet.
                try:
                    audiobook_response = supabase.table('audiobooks').insert(audiobook_data).execute()
                except Exception as ab_insert_err:
                    err_str = str(ab_insert_err).lower()
                    retried = False
                    if 'language' in err_str and 'language' in audiobook_data:
                        print('[WARN] language column missing, retrying audiobook insert without it')
                        audiobook_data.pop('language', None)
                        retried = True
                    if 'source_hash' in err_str and 'source_hash' in audiobook_data:
                        print('[WARN] source_hash column missing, retrying audiobook insert without it')
                        audiobook_data.pop('source_hash', None)
                        retried = True
                    if retried:
                        audiobook_response = supabase.table('audiobooks').insert(audiobook_data).execute()
                    else:
                        raise
                audiobook_id = audiobook_response.data[0]['id']

                # Karaoke timings go to the CDN, not Postgres (migration 016).
                # Migration state is independent of deploys, so probe once: if
                # the column isn't there yet, this whole conversion silently
                # behaves exactly as it did pre-016.
                offload_timings = True
                try:
                    supabase.table('audiobook_chapters')\
                        .select('word_timings_url').limit(1).execute()
                except Exception as probe_err:
                    offload_timings = False
                    print(f'[WARN] word_timings_url unavailable, storing timings '
                          f'inline (apply migration 016): {probe_err}')

                timing_urls = {}
                if offload_timings:
                    with ThreadPoolExecutor(max_workers=4) as pool:
                        upload_futures = {
                            pool.submit(
                                upload_word_timings,
                                ch.get('word_timings'),
                                f"{audiobook_id}_{ch['position']}",
                            ): ch['position']
                            for ch in converted_chapters if ch.get('word_timings')
                        }
                        for future in as_completed(upload_futures):
                            position = upload_futures[future]
                            try:
                                uploaded_url = future.result()
                            except Exception as up_err:
                                print(f'[WARN] word_timings upload raised for chapter '
                                      f'{position}: {up_err}')
                                uploaded_url = None
                            if uploaded_url:
                                timing_urls[position] = uploaded_url

                # Insert chapters. word_timings is written inline ONLY when the
                # CDN upload didn't happen — a failed upload degrades to the old
                # behaviour (costs database size) rather than losing karaoke.
                chapter_rows = []
                for ch in converted_chapters:
                    timings_url = timing_urls.get(ch['position'])
                    row = {
                        'audiobook_id': audiobook_id,
                        'chapter_id': ch['id'],
                        'title': ch['title'],
                        'position': ch['position'],
                        'audio_url': ch['audioUrl'],
                        'duration': ch.get('duration', 0),
                        'word_timings': None if timings_url else ch.get('word_timings'),
                        'image_inserts': ch.get('imageInserts') or None,  # None → NULL if empty
                    }
                    if timings_url:
                        row['word_timings_url'] = timings_url
                    chapter_rows.append(row)

                if timing_urls:
                    print(f'  [word_timing] {len(timing_urls)}/{len(chapter_rows)} chapters '
                          f'offloaded to CDN')

                # Insert chapters ONE AT A TIME with a two-stage fallback:
                #
                # 1. Normal insert (with word_timings — the karaoke data).
                # 2. On Supabase statement timeout (57014): retry the same
                #    chapter WITHOUT word_timings. Audio still plays —
                #    karaoke degrades for that chapter only.
                #
                # Why per-chapter, not batched: synthetic word-timings
                # (the fallback we use when edge-tts emits 0 WordBoundary
                # events — common on en-GB-RyanNeural and observed on
                # en-US-AndrewMultilingualNeural too, see 2026-05-28 logs)
                # generate one entry per word. A 5,000-word chapter produces
                # ~400 KB of JSONB. Three of those in a single statement can
                # exceed Supabase's per-statement timeout and roll back the
                # *entire batch* — which previously lost the whole book
                # silently because the outer `except` only logged the error
                # and let the conversion continue, leaving an orphan
                # audiobook row with zero chapters.
                #
                # Per-chapter inserts mean one oversized chapter degrades to
                # no-karaoke (audio + chapter row still saved) — the rest of
                # the book is unaffected. The book always reaches the user's
                # library. This mirrors the proven flow in
                # deliver_book_resumable.py used to recover the customer's
                # 2.74M-word "Good War" delivery.
                chapters_saved_full = 0
                chapters_saved_no_timings = 0
                chapters_save_failed = 0

                def _insert_one_chapter(row):
                    """Insert one chapter row with image_inserts + word_timings fallbacks.

                    Returns one of: 'full' (normal save), 'no_timings'
                    (saved without karaoke for this chapter), 'failed'
                    (couldn't even save the audio_url metadata).
                    """
                    try:
                        supabase.table('audiobook_chapters').insert(row).execute()
                        return 'full'
                    except Exception as ch_err:
                        err_str = str(ch_err).lower()
                        # Schema-cache: image_inserts column might not exist
                        # yet (pre-migration 007). Same defensive retry the
                        # batched version had.
                        if 'image_inserts' in err_str:
                            print(f"[WARN] image_inserts column missing for chapter {row.get('position')}; retrying without it")
                            row = {k: v for k, v in row.items() if k != 'image_inserts'}
                            try:
                                supabase.table('audiobook_chapters').insert(row).execute()
                                return 'full'
                            except Exception as ch_err2:
                                ch_err = ch_err2
                                err_str = str(ch_err2).lower()
                        # Statement timeout — payload (almost certainly
                        # word_timings) too big for Supabase's per-statement
                        # limit. Drop the timings and retry so audio still
                        # plays. Karaoke degrades for this one chapter.
                        if '57014' in err_str or 'statement timeout' in err_str or 'canceling statement' in err_str:
                            print(f"[WARN] chapter {row.get('position')} timed out — saving without word_timings (karaoke degraded for this chapter only)")
                            row = {k: v for k, v in row.items() if k != 'word_timings'}
                            try:
                                supabase.table('audiobook_chapters').insert(row).execute()
                                return 'no_timings'
                            except Exception as ch_err3:
                                print(f"[ERROR] chapter {row.get('position')} failed even without word_timings: {ch_err3}")
                                return 'failed'
                        # A transient connection drop — Supabase closed the
                        # socket mid-INSERT ("Server disconnected" /
                        # RemoteProtocolError). Observed 2026-06-15 silently
                        # dropping chapter 6 of a 43-chapter book while the
                        # conversion still reported complete (a NULL-audio gap
                        # the user never saw). These are not data errors; a
                        # reconnect-and-retry almost always succeeds, so retry
                        # before giving up rather than losing the chapter.
                        transient = any(s in err_str for s in (
                            'server disconnected', 'remoteprotocol', 'remote protocol',
                            'connection reset', 'connection aborted', 'broken pipe',
                            'connection error', 'connection refused', 'read timed out',
                        ))
                        if transient:
                            for attempt in range(3):
                                time.sleep(1 + attempt)
                                try:
                                    # Guard against a duplicate: the failed POST
                                    # may have committed server-side before the
                                    # socket dropped. If the row is already
                                    # present, the chapter IS saved — don't
                                    # insert it a second time (no unique
                                    # constraint protects us here).
                                    existing = (supabase.table('audiobook_chapters')
                                                .select('id')
                                                .eq('audiobook_id', row['audiobook_id'])
                                                .eq('position', row['position'])
                                                .limit(1).execute())
                                    if existing.data:
                                        print(f"[recovered] chapter {row.get('position')} already saved (committed before disconnect)")
                                        return 'full'
                                    supabase.table('audiobook_chapters').insert(row).execute()
                                    print(f"[recovered] chapter {row.get('position')} inserted on retry {attempt + 1}/3")
                                    return 'full'
                                except Exception as retry_err:
                                    print(f"[WARN] chapter {row.get('position')} retry {attempt + 1}/3 failed: {retry_err}")
                            print(f"[ERROR] chapter {row.get('position')} still failing after 3 retries")
                        # Some other error class (auth, network, unknown
                        # schema mismatch). Log and continue — one bad
                        # chapter shouldn't sink the whole save.
                        print(f"[ERROR] chapter {row.get('position')} insert failed: {ch_err}")
                        return 'failed'

                for i, row in enumerate(chapter_rows, start=1):
                    outcome = _insert_one_chapter(row)
                    if outcome == 'full':
                        chapters_saved_full += 1
                    elif outcome == 'no_timings':
                        chapters_saved_no_timings += 1
                    else:
                        chapters_save_failed += 1
                    print(f"  💾 chapter {i}/{len(chapter_rows)}: {outcome}")

                total_saved = chapters_saved_full + chapters_saved_no_timings
                if total_saved == 0:
                    # Catastrophic — nothing made it to the DB. Clean up the
                    # orphan audiobook row so the library doesn't show a
                    # broken book, and raise so the outer handler sets
                    # task.error → frontend fires `conversion_failed`
                    # analytics + shows an error UI.
                    print(f"❌ All {len(chapter_rows)} chapter inserts failed; deleting orphan audiobook {audiobook_id}")
                    try:
                        supabase.table('audiobooks').delete().eq('id', audiobook_id).execute()
                    except Exception as cleanup_err:
                        print(f"[WARN] orphan audiobook cleanup failed (will be reaped by quarterly orphan sweep): {cleanup_err}")
                    raise RuntimeError(
                        f"All {len(chapter_rows)} chapter inserts failed for '{ebook_title}'."
                    )

                if chapters_saved_no_timings or chapters_save_failed:
                    print(f"⚠ Save partial: {chapters_saved_full} full, "
                          f"{chapters_saved_no_timings} without karaoke timings, "
                          f"{chapters_save_failed} failed / {len(chapter_rows)} total")

                # Sum chapter durations onto the audiobook row. Without this
                # the audiobooks.duration stays at 0 and the frontend can't
                # compute progress (position / duration), so progress bars
                # in the library and Player look broken until you finish a
                # book and `current_position` saturates.
                total_duration_s = sum(int(row.get('duration') or 0) for row in chapter_rows)
                if total_duration_s > 0:
                    try:
                        supabase.table('audiobooks')\
                            .update({'duration': total_duration_s})\
                            .eq('id', audiobook_id)\
                            .execute()
                        print(f"  ⏱  audiobook duration set to {total_duration_s}s "
                              f"({total_duration_s // 60} min)")
                    except Exception as dur_err:
                        # Non-fatal — the audiobook is saved either way. Worst
                        # case the progress bar shows 0% until the next time
                        # the row is touched.
                        print(f"[WARN] could not set audiobook.duration: {dur_err}")

                task_manager.update_task(task_id, {'database_id': audiobook_id})

                # Increment the LIFETIME conversion counter (June 2026 v2 gate).
                # Repurposed `profiles.conversion_count`: +1 per COMPLETED
                # conversion for authenticated users, never decreases (deleting a
                # book does not free a slot). Atomic Postgres RPC so concurrent
                # completions can't race/under-count; falls back to
                # read-modify-write if the RPC isn't deployed yet (migration 012).
                # Anonymous trials have no profile row (their "1 lifetime" cap is
                # row-existence at gate time, not a counter).
                if user_id:
                    try:
                        supabase.rpc('increment_conversion_count',
                                     {'p_user_id': user_id}).execute()
                    except Exception as rpc_err:
                        print(f"[WARN] increment_conversion_count RPC failed ({rpc_err}); read-modify-write fallback")
                        prof = supabase.table('profiles').select('conversion_count').eq('id', user_id).single().execute()
                        cur = (prof.data or {}).get('conversion_count', 0) or 0
                        supabase.table('profiles') \
                            .update({'conversion_count': cur + 1}) \
                            .eq('id', user_id) \
                            .execute()
                    print(f"✓ Incremented lifetime conversion count for user {user_id}")
                else:
                    print(f"✓ Anonymous trial conversion for device {(device_id or '')[:8]}... — no counter")

                owner_label = f"user {user_id}" if user_id else f"device {(device_id or '')[:8]}..."
                print(f"✓ Saved audiobook {audiobook_id} to database for {owner_label}")
                db_save_ok = True
            except Exception as db_error:
                # Surface the failure to the frontend instead of silently
                # leaving the task marked complete with no database_id.
                # ConversionContext.tsx (line ~349) dispatches on
                # `serverTask.error` to fire `conversion_failed` analytics
                # AND to render an error UI. Without setting error here, the
                # user would see "Audiobook Ready! 🎧" + an empty library —
                # the exact failure mode the 2026-05-28 logs revealed.
                print(f"⚠ Error saving to database: {db_error}")
                task_manager.update_task(task_id, {
                    'error': f"Couldn't save your audiobook to your library: {db_error}",
                })

            # Only push "Ready!" when there is actually something ready.
            # A misleading push is worse than no push — it sends the user
            # into an empty library and erodes trust. Anonymous trials are
            # pushed by device (device_push_tokens) since 2026-09-14; before
            # that, 6 of 11 delivered books in a week went unannounced.
            #
            # "Ready" also has to mean COMPLETE. A partial conversion gets its
            # own wording rather than the celebratory one: on 2026-10-16 a
            # customer was pushed "Audiobook Ready! 🎧" for a 77-chapter novel
            # containing 25 chapters, an hour after being told the service was
            # fixed. Say what actually happened instead.
            if db_save_ok and (user_id or device_id):
                if missing_count > 0:
                    push_title = 'Conversion incomplete'
                    push_body = (
                        f'"{ebook_title}" converted {len(converted_chapters)} of '
                        f'{attempted_count} chapters. Open the app to try again.'
                    )
                else:
                    push_title = 'Audiobook Ready! 🎧'
                    push_body = f'"{ebook_title}" has finished converting.'
                send_push_notification(
                    user_id,
                    title=push_title,
                    body=push_body,
                    data={'task_id': task_id},
                    device_id=None if user_id else device_id,
                )

    except Exception as e:
        print(f"Error in chapters conversion task {task_id}: {e}")
        task_manager.update_task(task_id, {
            'error': str(e),
            'complete': True
        })

def process_conversion(task_id, epub_path, voice_id):
    audio_path = None
    try:
        task_manager.update_task(task_id, {
            'status': 'Extracting text from EPUB...',
            'progress': 10
        })
        text = extract_epub_text(epub_path)

        try:
            os.unlink(epub_path)
        except Exception as e:
            print(f"Warning: Could not delete temp epub file {epub_path}. Reason: {e}")

        if not text or len(text.strip()) == 0:
            raise ValueError("No text found in EPUB file")

        words = text.split()
        status_msg = f'Extracted {len(words)} words. Converting... (1/2)'

        task_manager.update_task(task_id, {
            'status': status_msg,
            'progress': 30
        })

        audio_path = os.path.join(tempfile.gettempdir(), f'audiobook_{task_id}.mp3')

        # Progress callback for TTS generation
        def progress_callback(p):
            task_manager.update_task(task_id, {'progress': p})

        create_audiobook(text, audio_path, voice_id, progress_callback)

        if not os.path.exists(audio_path):
            raise IOError("Audio file was not generated by TTS engine.")

        task_manager.update_task(task_id, {'status': 'Uploading to cloud... (2/2)'})
        upload_result = cloudinary.uploader.upload(audio_path, resource_type="video")

        task_manager.update_task(task_id, {
            'status': 'Complete!',
            'progress': 100,
            'complete': True,
            'audio_url': upload_result['secure_url']
        })

        task = task_manager.get_task(task_id)
        user_id = task.get('user_id') if task else None
        ebook_title = task.get('title', 'Your audiobook') if task else 'Your audiobook'
        if user_id:
            send_push_notification(
                user_id,
                title='Audiobook Ready! 🎧',
                body=f'"{ebook_title}" has finished converting.',
                data={'task_id': task_id},
            )

    except Exception as e:
        print(f"Error in task {task_id}: {e}")
        task_manager.update_task(task_id, {
            'error': str(e),
            'complete': True
        })
    finally:
        if audio_path and os.path.exists(audio_path):
            try:
                os.unlink(audio_path)
            except Exception as e:
                print(f"Warning: Could not delete temp audio file {audio_path}. Reason: {e}")

def process_text_conversion(task_id, text, voice_id):
    """Process plain text conversion to audio"""
    audio_path = None
    try:
        task_manager.update_task(task_id, {
            'status': 'Converting text... (1/2)',
            'progress': 30
        })

        audio_path = os.path.join(tempfile.gettempdir(), f'audiobook_{task_id}.mp3')

        # Progress callback for TTS generation
        def progress_callback(p):
            task_manager.update_task(task_id, {'progress': p})

        create_audiobook(text, audio_path, voice_id, progress_callback)

        if not os.path.exists(audio_path):
            raise IOError("Audio file was not generated by TTS engine.")

        task_manager.update_task(task_id, {'status': 'Uploading to cloud... (2/2)'})
        upload_result = cloudinary.uploader.upload(audio_path, resource_type="video")

        task_manager.update_task(task_id, {
            'status': 'Complete!',
            'progress': 100,
            'complete': True,
            'audio_url': upload_result['secure_url']
        })

        task = task_manager.get_task(task_id)
        user_id = task.get('user_id') if task else None
        if user_id:
            send_push_notification(
                user_id,
                title='Audiobook Ready! 🎧',
                body='Your text conversion has finished.',
                data={'task_id': task_id},
            )

    except Exception as e:
        print(f"Error in task {task_id}: {e}")
        task_manager.update_task(task_id, {
            'error': str(e),
            'complete': True
        })
    finally:
        if audio_path and os.path.exists(audio_path):
            try:
                os.unlink(audio_path)
            except Exception as e:
                print(f"Warning: Could not delete temp audio file {audio_path}. Reason: {e}")

# ── Queue adapter functions ────────────────────────────────────────────────────
# These translate the (task_id, task_row) signature used by QueueWorker into
# the existing process_* function signatures. process_* functions are unchanged.

def _queue_process_chapters(task_id: str, _task_row: dict) -> None:
    from queue_manager import is_task_cancelled
    task = task_manager.get_task(task_id)
    if not task:
        raise ValueError(f"Task {task_id} not found")
    supabase = get_supabase_client()
    process_chapters_conversion(
        task_id,
        chapters=task.get('chapters') or [],
        voice_id=task.get('voice_id', list(VOICES.values())[0]),
        use_emotional_director=bool(task.get('use_emotional_director', False)),
        generate_word_timings=bool(task.get('generate_word_timings', True)),
        cancel_check=lambda: is_task_cancelled(supabase, task_id),
    )


def _queue_process_epub(task_id: str, _task_row: dict) -> None:
    task = task_manager.get_task(task_id)
    if not task:
        raise ValueError(f"Task {task_id} not found")
    epub_path = task.get('epub_path')
    if not epub_path or not os.path.exists(epub_path):
        raise FileNotFoundError(
            f"EPUB temp file not found for task {task_id}. "
            "The server may have restarted — please re-upload the file."
        )
    process_conversion(task_id, epub_path, task.get('voice_id', list(VOICES.values())[0]))


def _queue_process_text(task_id: str, _task_row: dict) -> None:
    task = task_manager.get_task(task_id)
    if not task:
        raise ValueError(f"Task {task_id} not found")
    text = task.get('text_content')
    if not text:
        raise ValueError(f"No text_content in task {task_id}")
    process_text_conversion(task_id, text, task.get('voice_id', list(VOICES.values())[0]))


# Register handlers so QueueWorker knows which function handles each type
register_handler('chapters', _queue_process_chapters)
register_handler('epub', _queue_process_epub)
register_handler('text', _queue_process_text)


@app.route('/api/conversions/active', methods=['GET'])
@optional_auth
def get_active_conversions():
    """
    Return all active (queued + processing) and recently completed conversions
    for the requester. Called by ConversionContext on app resume.

    Accepts authenticated (Bearer JWT, uses the get_active_conversions_for_user
    RPC) or anonymous (X-Device-Id header, direct table query — no RPC equivalent
    exists for device_id and we don't want to introduce one for a feature with
    at most 1 active row per device).

    The chapters field is stripped from each row — it can be 700+ KB per
    conversion and the frontend only needs status fields here.  Without the
    strip, a user with 2-3 active conversions could see a multi-MB response
    on every app resume.
    """
    user_id = request.user_id
    device_id = request.device_id

    if not user_id and not device_id:
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

    try:
        supabase = get_supabase_client()
        if user_id:
            result = supabase.rpc(
                'get_active_conversions_for_user',
                {'p_user_id': user_id},
            ).execute()
            rows = result.data or []
        else:
            # Anonymous: direct table query. Mirrors what the RPC would do but
            # filtered by device_id. Only fetches rows from the last 24h to
            # cap response size and skip ancient cancelled/done rows.
            from datetime import datetime, timezone, timedelta
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
            # Slim projection — this list is polled and only the status fields
            # are returned (see the `slim` comprehension below), so never pull
            # the `chapters` blob out of Supabase here. Fall back to '*' if a
            # column is unknown in this environment so anon trial users never
            # get a 500 (mirrors task_manager.get_task).
            def _active_query(cols):
                return supabase.table('conversion_tasks') \
                    .select(cols) \
                    .eq('device_id', device_id) \
                    .gte('queued_at', cutoff) \
                    .order('queued_at', desc=True) \
                    .limit(5) \
                    .execute()
            try:
                result = _active_query(_STATUS_DB_COLUMNS)
            except Exception as col_err:
                es = str(col_err).lower()
                if 'column' in es or 'does not exist' in es or '42703' in es:
                    print(f'[WARN] active-conversions slim projection failed, retrying with *: {col_err}')
                    result = _active_query('*')
                else:
                    raise
            rows = result.data or []
        slim = [
            {k: v for k, v in row.items() if k in _PROGRESS_STATUS_FIELDS or k == 'created_at' or k == 'updated_at'}
            for row in rows
        ]
        return jsonify({'conversions': slim})
    except Exception as e:
        print(f"[ERROR] get_active_conversions: {e}")
        return jsonify({'error': 'Failed to fetch active conversions'}), 500


@app.route('/api/conversions/<task_id>/cancel', methods=['POST'])
@optional_auth
def cancel_conversion(task_id):
    """Cancel a queued or in-progress conversion. Accepts user or device identity."""
    user_id = request.user_id
    device_id = request.device_id

    if not user_id and not device_id:
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

    try:
        validate_task_id(task_id)
    except ValidationError:
        return jsonify({'error': 'Invalid task ID'}), 400

    task = task_manager.get_task(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    task_user_id = task.get('user_id')
    task_device_id = task.get('device_id')
    if task_user_id is not None:
        if task_user_id != user_id:
            return jsonify({'error': 'Task not found'}), 404
    elif task_device_id is not None:
        if task_device_id != device_id:
            return jsonify({'error': 'Task not found'}), 404

    current_status = task.get('queue_status')
    if current_status in ('done', 'failed', 'cancelled'):
        return jsonify({'error': 'Task already finished'}), 409

    supabase = get_supabase_client()
    supabase.table('conversion_tasks').update({
        'queue_status': 'cancelled',
        'complete': True,
        'error': 'Cancelled by user',
    }).eq('id', task_id).execute()

    owner_label = f"user {user_id}" if user_id else f"device {(device_id or '')[:8]}..."
    print(f"[ConversionQueue] Task {task_id} cancelled by {owner_label}")
    return jsonify({'success': True})


# Fields returned by /status while a task is in progress. We deliberately
# omit `chapters` because for a long book the input-chapter payload is
# 700+ KB and the frontend polls every ~3 s — that's >12 MB of bandwidth
# per minute *and* per-poll Python allocations that pressure the 512 MB
# Render Starter cap. The chapters field is only needed once the task is
# complete (audioUrl + word_timings live there), so we include the full
# row on completion only.
_PROGRESS_STATUS_FIELDS = {
    'id', 'status', 'progress', 'complete', 'error',
    'queue_status', 'queueStatus',
    'eta_seconds', 'etaSeconds',
    'audioUrl', 'audio_url',
    'database_id',
    'conversion_type',
    'title',
    'voice_id',
}

# Real DB column projection for the /status polling path. Selecting these
# explicitly (instead of '*') keeps the multi-hundred-KB `chapters` JSON blob
# inside Supabase on every ~3s poll — pulling it was the dominant free-tier
# egress sink. Only snake_case DB columns belong here (the camelCase entries in
# _PROGRESS_STATUS_FIELDS are aliases used to filter already-shaped dicts, not
# real columns). user_id/device_id are included so the ownership check can run
# off the same slim row. get_task() falls back to '*' if any column is unknown.
#
# IMPORTANT: every column listed here MUST exist in the prod `conversion_tasks`
# table. If even one is unknown, get_task()'s slim SELECT fails and falls back to
# '*', which drags the multi-hundred-KB `chapters` blob out of Supabase on EVERY
# ~3s poll — silently re-creating the exact egress sink this projection exists to
# prevent. (`queue_position` was such a phantom column — never created by any
# migration, never written by any code — and was removed for this reason.)
_STATUS_DB_COLUMNS = (
    'id, status, progress, complete, error, '
    'queue_status, eta_seconds, '
    'audio_url, database_id, conversion_type, title, '
    'voice_id, created_at, updated_at, '
    'user_id, device_id'
)


@app.route('/status/<task_id>')
@optional_auth
@require_task_ownership(task_manager)
def status(task_id):
    """Get conversion task status with ownership verification."""
    # SECURITY: Validate task_id format
    try:
        validate_task_id(task_id)
    except ValidationError as e:
        return jsonify({'error': 'Invalid task ID'}), 400

    # Slim projection: while a conversion is in flight this endpoint is polled
    # every ~3s, and selecting '*' would drag the multi-hundred-KB `chapters`
    # blob out of Supabase on every poll (the free-tier egress sink). The slim
    # row carries everything the in-progress client needs.
    task = task_manager.get_task(task_id, columns=_STATUS_DB_COLUMNS,
                                 distinguish_errors=True)
    if task is task_manager.DB_ERROR:
        # DB unreachable (Supabase outage) ≠ task gone — 503 keeps the client
        # polling instead of tripping its 3-strike 404 drop counter.
        return jsonify({'error': 'Status temporarily unavailable. Please retry.'}), 503
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    if not task.get('complete'):
        # In progress: return only the status fields (no chapters needed).
        task = {k: v for k, v in task.items() if k in _PROGRESS_STATUS_FIELDS}
        return jsonify(task)

    # Complete: the client now needs the converted chapters (audio URLs + word
    # timings), so fetch the full row once. This '*' read happens a single time
    # per conversion instead of on every poll.
    full = task_manager.get_task(task_id)
    return jsonify(full or task)

def send_push_notification(user_id, title, body, data=None, device_id=None):
    """
    Send an Expo push notification to a user's device — looked up by account
    (profiles.expo_push_token) or, for an anonymous trial, by device
    (device_push_tokens). Pass exactly one of user_id / device_id.
    """
    owner = f"user {user_id}" if user_id else f"device {(device_id or '')[:8]}..."
    try:
        supabase = get_supabase_client()
        token = None
        if user_id:
            result = supabase.table('profiles').select('expo_push_token').eq('id', user_id).single().execute()
            token = result.data.get('expo_push_token') if result.data else None
        elif device_id:
            result = supabase.table('device_push_tokens').select('expo_push_token') \
                .eq('device_id', device_id).limit(1).execute()
            token = result.data[0].get('expo_push_token') if result.data else None
        if not token:
            return
        payload = {
            'to': token,
            'title': title,
            'body': body,
            'sound': 'default',
            'data': data or {},
        }
        response = http_requests.post(
            'https://exp.host/--/api/v2/push/send',
            json=payload,
            headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
            timeout=10,
        )
        print(f"✓ Push notification sent to {owner}: {response.status_code}")
    except Exception as e:
        print(f"⚠ Failed to send push notification to {owner}: {e}")


@app.route('/api/push-token', methods=['POST'])
@optional_auth
def save_push_token():
    """
    Save or update the Expo push token — for the signed-in user, or, with no
    session, for the anonymous device (X-Device-Id).

    Was @require_auth, which meant the "Audiobook Ready" push only ever
    reached accounts; anonymous trials (the funnel) waited on the Conversion
    screen or found the book days later. Device tokens live in
    device_push_tokens (migration 011) and move to the profile on claim.
    """
    token = request.json.get('token') if request.json else None
    if not token or not isinstance(token, str) or not token.startswith('ExponentPushToken['):
        return jsonify({'error': 'Invalid push token'}), 400
    try:
        supabase = get_supabase_client()
        if request.user_id:
            supabase.table('profiles').update({'expo_push_token': token}).eq('id', request.user_id).execute()
            return jsonify({'success': True, 'scope': 'user'})
        if request.device_id:
            supabase.table('device_push_tokens').upsert({
                'device_id': request.device_id,
                'expo_push_token': token,
                'updated_at': datetime.now(dt_timezone.utc).isoformat(),
            }, on_conflict='device_id').execute()
            return jsonify({'success': True, 'scope': 'device'})
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401
    except Exception as e:
        print(f"Error saving push token: {e}")
        return jsonify({'error': 'Failed to save token'}), 500


@app.route('/api/push-token', methods=['DELETE'])
@require_auth
def clear_push_token():
    """
    Clear the Expo push token for the authenticated user.

    Called by the mobile app immediately before sign-out so that the next
    user who signs in on the same physical device isn't accidentally
    routed notifications meant for the account that just signed out.
    Without this, every account that has *ever* signed in on a device
    keeps that device's push token on their profile row — meaning a
    conversion completing under account A could ring account B's phone.
    """
    try:
        supabase = get_supabase_client()
        supabase.table('profiles').update({'expo_push_token': None}).eq('id', request.user_id).execute()
        return jsonify({'success': True})
    except Exception as e:
        print(f"Error clearing push token: {e}")
        return jsonify({'error': 'Failed to clear token'}), 500


@app.route('/api/profile', methods=['GET'])
@require_auth
def get_profile():
    """Get user profile"""
    try:
        user_id = request.user_id
        profile = get_user_profile(user_id)

        if not profile:
            return jsonify({'error': 'Profile not found'}), 404

        # Count user's audiobooks
        supabase = get_supabase_client()
        audiobook_count = supabase.table('audiobooks') \
            .select('id', count='exact') \
            .eq('user_id', user_id) \
            .execute()

        total_audiobooks = audiobook_count.count or 0

        monthly_count = profile.get('monthly_conversion_count', 0) or 0
        max_monthly = profile.get('max_monthly_conversions')
        # None on max_monthly means unlimited (Pro/Enterprise).  For the UI:
        #   monthlyConversionsRemaining: number | null  (null = unlimited)
        if max_monthly is None:
            remaining = None
        else:
            remaining = max(0, max_monthly - monthly_count)

        # Conversion-credit gate (June 2026 v3 — the live paid gate). The
        # allowance accrues monthly (tier_limits.conversion_allowance); the
        # count is the lifetime conversion_count. Field names kept from v2
        # for app-binary compatibility — maxLifetimeConversions now means
        # "current accrued allowance" and grows over time.
        from tier_limits import conversion_allowance, limits_for
        tier = profile.get('subscription_tier', 'free')
        lifetime_count = profile.get('conversion_count', 0) or 0
        max_lifetime = conversion_allowance(tier, profile.get('created_at'))
        lifetime_remaining = None if max_lifetime is None else max(0, max_lifetime - lifetime_count)
        max_book_words = limits_for(tier).get('max_conversion_words')

        # Transform profile to match frontend User interface
        user_data = {
            'id': profile['id'],
            'email': profile.get('email', ''),
            'firstName': profile.get('first_name'),
            'lastName': profile.get('last_name'),
            'displayName': profile.get('display_name', profile.get('email', '').split('@')[0]),
            'avatar': profile.get('avatar_url'),
            'plan': profile.get('subscription_tier', 'free'),
            'conversionCount': lifetime_count,
            'maxConversions': profile.get('max_conversions', 10),
            # Credit gate (live): conversionCount above is the lifetime count;
            # maxLifetimeConversions is the current accrued allowance.
            'maxLifetimeConversions': max_lifetime,
            'lifetimeConversionsRemaining': lifetime_remaining,
            # Per-book word cap for this tier (null = uncapped up to the
            # global infra limit). New in June 2026 v3.
            'maxConversionWords': max_book_words,
            'audiobookCount': total_audiobooks,
            'maxAudiobooks': profile.get('max_audiobooks', 10),
            'monthlyConversionCount': monthly_count,
            'maxMonthlyConversions': max_monthly,
            'monthlyConversionsRemaining': remaining,
            'conversionResetAt': profile.get('conversion_count_reset_at'),
            'stripeCustomerId': profile.get('stripe_customer_id'),
            'stripeSubscriptionId': profile.get('stripe_subscription_id'),
            'subscriptionStatus': profile.get('subscription_status'),
            'subscriptionCurrentPeriodEnd': profile.get('subscription_current_period_end'),
            'subscriptionCancelAtPeriodEnd': profile.get('subscription_cancel_at_period_end'),
            'karaokeTrialUsed': bool(profile.get('karaoke_trial_used', False)),
            # Terms re-consent gate: the frontend shows a one-time prompt when
            # termsAcceptedVersion != termsCurrentVersion (or accepted is null).
            'termsAcceptedVersion': profile.get('terms_accepted_version'),
            'termsCurrentVersion': TERMS_VERSION,
        }

        return jsonify({'profile': user_data})
    except Exception as e:
        print(f'Error fetching profile: {e}')
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to fetch profile'}), 500

@app.route('/api/profile/accept-terms', methods=['POST'])
@require_auth
def accept_terms():
    """Record that the authenticated user has accepted the current Terms version.

    Called by the in-app re-consent gate when the user taps "Agree & Continue".
    Stamps the user's profile with the current TERMS_VERSION + timestamp so the
    prompt is shown only once (until the next material Terms change bumps the
    version)."""
    try:
        user_id = request.user_id
        supabase = get_supabase_client()
        supabase.table('profiles').update({
            'terms_accepted_version': TERMS_VERSION,
            'terms_accepted_at': datetime.now(dt_timezone.utc).isoformat(),
        }).eq('id', user_id).execute()
        return jsonify({'success': True, 'termsAcceptedVersion': TERMS_VERSION})
    except Exception as e:
        print(f'Error recording terms acceptance: {e}')
        return jsonify({'error': 'Failed to record terms acceptance'}), 500

@app.route('/api/profile/karaoke-trial', methods=['POST'])
@require_auth
def mark_karaoke_trial_used():
    """Mark the free karaoke trial as used for this user."""
    try:
        user_id = request.user_id
        supabase = get_supabase_client()
        supabase.table('profiles').update({'karaoke_trial_used': True}).eq('id', user_id).execute()
        return jsonify({'success': True})
    except Exception as e:
        print(f'Error marking karaoke trial used: {e}')
        return jsonify({'error': 'Failed to update karaoke trial status'}), 500


@app.route('/api/profile', methods=['PUT'])
@require_auth
def update_profile():
    """Update user profile display name and email"""
    try:
        user_id = request.user_id
        data = request.get_json() or {}

        allowed_fields = {'first_name', 'last_name', 'display_name', 'email'}
        update_data = {k: v for k, v in data.items() if k in allowed_fields and isinstance(v, str) and v.strip()}

        if not update_data:
            return jsonify({'error': 'No valid fields to update'}), 400

        supabase = get_supabase_client()
        # upsert handles the case where the profile row doesn't exist yet (e.g. new Google OAuth user)
        supabase.table('profiles').upsert({**update_data, 'id': user_id}, on_conflict='id').execute()

        return jsonify({'success': True})
    except Exception as e:
        print(f'Error updating profile: {e}')
        return jsonify({'error': 'Failed to update profile'}), 500

@app.route('/api/audiobooks', methods=['GET'])
@optional_auth
def get_audiobooks():
    """
    Get audiobook library — metadata + lightweight chapter list only.

    Accepts either an authenticated user (Bearer JWT) or an anonymous device
    (X-Device-Id header). For anonymous, the library contains at most one
    audiobook — the trial conversion if any.

    The heavy karaoke fields (word_timings, image_inserts) are NOT returned
    here. For a long book those arrays can be 100-500 KB *per chapter*, which
    multiplied by chapters × books gives a 6+ MB response. The library screen
    only needs titles/covers/audio URLs — karaoke data is fetched on-demand
    by the Player via GET /api/audiobooks/<id>.
    """
    try:
        user_id = request.user_id
        device_id = request.device_id

        if not user_id and not device_id:
            return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

        supabase = get_supabase_client()

        # Ensure the profile row exists — creates it on first login if missing.
        # Anonymous users have no profile row.
        if user_id:
            get_user_profile(user_id)

        # Explicit column projection: do NOT pull word_timings or image_inserts.
        query = supabase.table('audiobooks')\
            .select(
                '*, audiobook_chapters('
                'chapter_id,title,audio_url,duration,position'
                ')'
            )
        if user_id:
            query = query.eq('user_id', user_id)
        else:
            query = query.eq('device_id', device_id)
        audiobooks_response = query.order('created_at', desc=True).execute()
        rows = list(audiobooks_response.data or [])

        # Append the shared demo book(s) so every identity — including a
        # brand-new anonymous device with an otherwise empty library — has
        # something to play immediately. Defensive try/except: if migration
        # 014 hasn't been applied yet the is_demo column doesn't exist and
        # this query fails; the library must still load without demo rows.
        try:
            own_ids = {b['id'] for b in rows}
            demo_response = supabase.table('audiobooks')\
                .select(
                    '*, audiobook_chapters('
                    'chapter_id,title,audio_url,duration,position'
                    ')'
                )\
                .eq('is_demo', True)\
                .execute()
            for demo in (demo_response.data or []):
                if demo['id'] not in own_ids:
                    rows.append(demo)
        except Exception as demo_err:
            print(f'[WARN] Demo audiobook fetch skipped: {demo_err}')

        audiobooks = []
        for book in rows:
            chapters = sorted(book.get('audiobook_chapters', []), key=lambda x: x['position'])

            audiobook = {
                'id': book['id'],
                'title': book['title'],
                'author': book.get('author'),
                'description': book.get('description'),
                'voiceId': book['voice_id'],
                'voiceName': book['voice_name'],
                'coverUrl': book.get('cover_url'),
                'duration': book.get('duration', 0),
                'createdAt': book['created_at'],
                'status': book['status'],
                'progress': book['progress'],
                'currentPosition': book['current_position'],
                'currentChapter': book['current_chapter'],
                'isCustom': book.get('is_custom', False),
                'isDemo': book.get('is_demo', False),
                'chapters': [
                    {
                        'id': ch['chapter_id'],
                        'title': ch['title'],
                        'audioUrl': ch['audio_url'],
                        'duration': ch['duration'],
                        'position': ch['position'],
                        # word_timings + imageInserts intentionally omitted here
                    }
                    for ch in chapters
                ] if chapters else None
            }
            audiobooks.append(audiobook)

        return jsonify({'audiobooks': audiobooks})
    except Exception as e:
        print(f'Error fetching audiobooks: {e}')
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to fetch audiobooks'}), 500


# Explicit chapter projection for the detail endpoint. Deliberately NOT
# `audiobook_chapters(*)`: the wildcard pulled every chapter's word_timings
# blob out of Postgres on every book open, which was the single largest
# source of Supabase egress. New rows carry `word_timings_url` and a NULL
# blob; legacy rows (pre-migration-016, pre-backfill) still carry the blob.
_CHAPTER_DETAIL_COLUMNS = (
    'chapter_id,title,audio_url,duration,position,'
    'word_timings,word_timings_url,image_inserts'
)
# Pre-016 databases have no word_timings_url column; PostgREST 400s on the
# whole select if we name it. Retry with this projection in that case.
_CHAPTER_DETAIL_COLUMNS_LEGACY = (
    'chapter_id,title,audio_url,duration,position,'
    'word_timings,image_inserts'
)


@app.route('/api/audiobooks/<audiobook_id>', methods=['GET'])
@optional_auth
def get_audiobook_detail(audiobook_id):
    """
    Return one audiobook with full karaoke data (word_timings + image_inserts).

    Called by the Player when a user opens a specific book — splits the heavy
    payload out of the library list call so the library load stays fast.

    `?timings=url` (phase 2 clients) returns `wordTimingsUrl` per chapter and
    skips server-side hydration, so the timings never travel through Render at
    all — the client fetches the chapter it needs straight from the CDN and
    caches it. Without the parameter the timings are hydrated inline, which is
    what builds 38 and 39 expect.

    Accepts either authenticated user (Bearer JWT) or anonymous device
    (X-Device-Id). Ownership is enforced at the query level: 404 is returned
    if the requester's identity doesn't match the row's identity.
    """
    user_id = request.user_id
    device_id = request.device_id

    if not user_id and not device_id:
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

    try:
        validate_audiobook_id(audiobook_id)
    except ValidationError:
        return jsonify({'error': 'Invalid audiobook id'}), 400

    try:
        supabase = get_supabase_client()

        def _fetch_book(chapter_columns):
            q = supabase.table('audiobooks')\
                .select(f'*, audiobook_chapters({chapter_columns})')\
                .eq('id', audiobook_id)
            if user_id:
                q = q.eq('user_id', user_id)
            else:
                q = q.eq('device_id', device_id)
            return getattr(q.maybe_single().execute(), 'data', None)

        chapter_columns = _CHAPTER_DETAIL_COLUMNS
        try:
            book = _fetch_book(chapter_columns)
        except Exception as col_err:
            if 'word_timings_url' not in str(col_err):
                raise
            print('[WARN] word_timings_url column missing; '
                  'serving inline timings (apply migration 016)')
            # Remember the downgrade so the demo query below matches; a
            # pre-016 database must still serve the first-launch demo book.
            chapter_columns = _CHAPTER_DETAIL_COLUMNS_LEGACY
            book = _fetch_book(chapter_columns)

        if not book:
            # Not one of the requester's books — but the shared demo book is
            # readable by every identity. Defensive try/except in case
            # migration 014 (is_demo) hasn't been applied yet.
            try:
                demo_result = supabase.table('audiobooks')\
                    .select(f'*, audiobook_chapters({chapter_columns})')\
                    .eq('id', audiobook_id)\
                    .eq('is_demo', True)\
                    .maybe_single().execute()
                book = getattr(demo_result, 'data', None)
            except Exception as demo_err:
                print(f'[WARN] Demo audiobook detail fetch skipped: {demo_err}')

        if not book:
            return jsonify({'error': 'Audiobook not found'}), 404

        chapters = sorted(book.get('audiobook_chapters', []), key=lambda x: x['position'])
        # Pull CDN-hosted timings back inline unless the client opted out.
        # Builds 38 and 39 expect `word_timings` in this response, so hydration
        # stays the default; phase-2 clients pass ?timings=url and fetch the one
        # chapter they need directly, which keeps Render out of the path.
        client_fetches_timings = request.args.get('timings') == 'url'
        if not client_fetches_timings:
            hydrate_word_timings(chapters)
        return jsonify({
            'audiobook': {
                'id': book['id'],
                'title': book['title'],
                'author': book.get('author'),
                'description': book.get('description'),
                'voiceId': book['voice_id'],
                'voiceName': book['voice_name'],
                'coverUrl': book.get('cover_url'),
                'duration': book.get('duration', 0),
                'createdAt': book['created_at'],
                'status': book['status'],
                'progress': book['progress'],
                'currentPosition': book['current_position'],
                'currentChapter': book['current_chapter'],
                'isCustom': book.get('is_custom', False),
                'isDemo': book.get('is_demo', False),
                'chapters': [
                    {
                        'id': ch['chapter_id'],
                        'title': ch['title'],
                        'audioUrl': ch['audio_url'],
                        'duration': ch['duration'],
                        'position': ch['position'],
                        'word_timings': ch.get('word_timings'),
                        # Present from migration 016. A phase-2 client fetches
                        # this itself; a legacy row has it NULL and carries the
                        # timings inline above, so both shapes stay playable.
                        'wordTimingsUrl': ch.get('word_timings_url'),
                        'imageInserts': ch.get('image_inserts') or [],
                    }
                    for ch in chapters
                ] if chapters else None,
            }
        })
    except Exception as e:
        print(f'Error fetching audiobook {audiobook_id}: {e}')
        return jsonify({'error': 'Failed to fetch audiobook'}), 500

_UUID_RE = __import__('re').compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    __import__('re').IGNORECASE,
)

@app.route('/api/audiobooks/<audiobook_id>/progress', methods=['PUT'])
@optional_auth
def update_progress(audiobook_id):
    """Update audiobook playback progress.

    Anonymous (device-id) listeners can save their place too — core listening,
    including resuming where you left off, is free. Ownership is resolved by the
    same (user_id XOR device_id) identity used for conversion and library reads,
    so the request never 401s just because the listener hasn't made an account.
    """
    try:
        user_id = request.user_id
        device_id = getattr(request, 'device_id', None)
        # Owner filter: authenticated users match on user_id, anonymous trial
        # listeners on device_id. Without either identity there's nothing to scope to.
        if user_id:
            owner_col, owner_val = 'user_id', user_id
        elif device_id:
            owner_col, owner_val = 'device_id', device_id
        else:
            return jsonify({'error': 'Authentication or X-Device-Id required'}), 401
        data = request.get_json()
        supabase = get_supabase_client()

        current_position = data.get('currentPosition', 0)
        current_chapter = data.get('currentChapter', 0)
        # Set by the client when the user deliberately moved the playhead
        # (slider, ±15 s, chapter change). Absent on older binaries → False.
        explicit_seek = bool(data.get('explicitSeek', False))

        print(f'📊 Received progress update: audiobook_id={audiobook_id}, position={current_position}, chapter={current_chapter}, explicit_seek={explicit_seek}')

        # The mobile may send a task-ID (e.g. "1772065320069_fa8ffb3d...") before the
        # library re-syncs with the DB.  Resolve it to the real UUID, or skip silently.
        if not _UUID_RE.match(audiobook_id):
            try:
                task = task_manager.get_task(audiobook_id)
                db_id = task.get('database_id') if task else None
                if db_id:
                    print(f'🔄 Resolved task ID to database UUID: {db_id}')
                    audiobook_id = db_id
                else:
                    # DB save hasn't finished yet — skip progress update, not an error
                    print(f'⏭️ Skipping progress: audiobook not yet in DB for task {audiobook_id}')
                    return jsonify({'success': True, 'progress': 0})
            except Exception:
                return jsonify({'success': True, 'progress': 0})

        # Convert to integers (database expects integer, frontend sends float)
        current_position = int(current_position) if current_position else 0
        current_chapter = int(current_chapter) if current_chapter else 0

        # Get audiobook with chapters to calculate total progress.
        # current_position/current_chapter come along for the regression guard below.
        audiobook = supabase.table('audiobooks') \
            .select('duration, status, current_position, current_chapter') \
            .eq('id', audiobook_id) \
            .eq(owner_col, owner_val) \
            .maybe_single() \
            .execute()

        if not getattr(audiobook, 'data', None):
            # Not the requester's book. If it's the shared demo book, ack the
            # save without writing — the row is shared by every listener, so
            # persisting one person's position would clobber everyone else's.
            # (Demo resume is client-side only for now.) Defensive try/except
            # in case migration 014 hasn't been applied yet.
            try:
                demo = supabase.table('audiobooks') \
                    .select('id') \
                    .eq('id', audiobook_id) \
                    .eq('is_demo', True) \
                    .maybe_single() \
                    .execute()
                if getattr(demo, 'data', None):
                    return jsonify({'success': True, 'progress': 0, 'demo': True})
            except Exception as demo_err:
                print(f'[WARN] Demo progress check skipped: {demo_err}')
            return jsonify({'error': 'Audiobook not found'}), 404

        print(f'📖 Audiobook data: duration={audiobook.data.get("duration") if audiobook.data else None}, status={audiobook.data.get("status") if audiobook.data else None}')

        # ── Bookmark regression guard ───────────────────────────────────────
        # A client that loses track of where it is (dropped resume-seek, stale
        # chapter ref, a status tick reporting 0 during a track swap) writes a
        # position far BEHIND the stored one and silently destroys the user's
        # place. That happened repeatedly in the 2026-08-10 logs: 1696s → 1432s,
        # 2119s → 1637s, 1089s → 599s, all on the same chapter, all accepted.
        #
        # A real listener only moves forward on their own, so a large backwards
        # jump within one chapter is a bug unless the user asked for it. Reject
        # it and ack with the stored value — never 4xx, the client is mid-playback
        # and an error here helps nobody.
        #
        # Only guards WITHIN a chapter: any chapter change is legitimate.
        if not explicit_seek and audiobook.data:
            stored_chapter = audiobook.data.get('current_chapter')
            stored_position = audiobook.data.get('current_position')
            if (
                stored_chapter == current_chapter
                and stored_position is not None
                and current_position < stored_position - PROGRESS_REGRESSION_TOLERANCE_S
            ):
                print(
                    f'🛑 Rejected progress regression: chapter={current_chapter}, '
                    f'{stored_position}s → {current_position}s '
                    f'(> {PROGRESS_REGRESSION_TOLERANCE_S}s backwards, not an explicit seek)'
                )
                return jsonify({
                    'success': True,
                    'rejected': 'regression',
                    'currentPosition': stored_position,
                    'currentChapter': stored_chapter,
                })

        # Get chapters to calculate cumulative progress
        chapters = supabase.table('audiobook_chapters') \
            .select('duration, position') \
            .eq('audiobook_id', audiobook_id) \
            .order('position') \
            .execute()

        print(f'📚 Found {len(chapters.data) if chapters.data else 0} chapters')

        # Calculate listening progress percentage
        listening_progress = 0
        total_elapsed_time = current_position  # Start with current position in current chapter

        if audiobook.data and audiobook.data['duration'] > 0:
            # If there are chapters, calculate cumulative time
            if chapters.data and len(chapters.data) > 0:
                # Add duration of all completed chapters (before current_chapter)
                for i, chapter in enumerate(chapters.data):
                    if i < current_chapter:
                        total_elapsed_time += chapter.get('duration', 0)
                        print(f'  Adding chapter {i} duration: {chapter.get("duration", 0)}')

                print(f'✅ Progress calculation: current_chapter={current_chapter}, current_position={current_position}, total_elapsed={total_elapsed_time}, total_duration={audiobook.data["duration"]}')

            # Calculate percentage
            listening_progress = int((total_elapsed_time / audiobook.data['duration']) * 100)
            listening_progress = min(100, max(0, listening_progress))  # Clamp 0-100
            print(f'📈 Calculated progress: {listening_progress}%')
        else:
            print(f'⚠️ Cannot calculate progress: duration is {audiobook.data.get("duration") if audiobook.data else "None"}')

        # Update audiobook with position and calculated progress
        update_data = {
            'current_position': current_position,
            'current_chapter': current_chapter,
            'updated_at': 'now()'
        }

        # Only update progress if audiobook is completed (not converting)
        if audiobook.data and audiobook.data['status'] == 'completed':
            update_data['progress'] = listening_progress
            print(f'✍️ Updating progress field to: {listening_progress}')
        else:
            print(f'⏭️ Skipping progress update (status is not completed)')

        supabase.table('audiobooks') \
            .update(update_data) \
            .eq('id', audiobook_id) \
            .eq(owner_col, owner_val) \
            .execute()

        print(f'💾 Database updated successfully')
        return jsonify({'success': True, 'progress': listening_progress})
    except Exception as e:
        print(f'Error updating progress: {e}')
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to update progress'}), 500

@app.route('/api/cover-upload', methods=['POST'])
@require_auth
def upload_cover():
    """Upload cover art image to Cloudinary and return the secure URL."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    content_type = file.content_type or ''
    allowed = ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
    if not any(ct in content_type for ct in allowed):
        return jsonify({'error': 'Invalid file type. Please upload JPG, PNG, or WebP.'}), 400

    # Read and size-check before uploading
    image_bytes = file.read()
    if len(image_bytes) > 5 * 1024 * 1024:
        return jsonify({'error': 'Image too large. Maximum 5 MB.'}), 400

    try:
        upload_result = cloudinary.uploader.upload(
            io.BytesIO(image_bytes),
            resource_type='image',
            folder='audiobook_covers',
            transformation=[
                {'width': 500, 'height': 500, 'crop': 'fill', 'gravity': 'auto'},
                {'quality': 'auto', 'fetch_format': 'auto'},
            ]
        )
        return jsonify({'coverUrl': upload_result['secure_url']})
    except Exception as e:
        print(f'[ERROR] Cover upload failed: {e}')
        return jsonify({'error': 'Failed to upload cover art'}), 500


@app.route('/api/audiobooks/<audiobook_id>/metadata', methods=['PUT'])
@require_auth
def update_audiobook_metadata(audiobook_id):
    """Update audiobook metadata: title, author, description, cover_url."""
    user_id = request.user_id
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    update_data = {}
    if 'title' in data:
        title = str(data['title']).strip()[:200]
        if not title:
            return jsonify({'error': 'Title cannot be empty'}), 400
        update_data['title'] = title
    if 'author' in data:
        update_data['author'] = str(data['author']).strip()[:200] if data['author'] else None
    if 'description' in data:
        update_data['description'] = str(data['description']).strip()[:2000] if data['description'] else None
    if 'coverUrl' in data:
        update_data['cover_url'] = data['coverUrl']

    if not update_data:
        return jsonify({'error': 'No valid fields to update'}), 400

    try:
        supabase = get_supabase_client()
        # Verify ownership before updating
        existing = supabase.table('audiobooks').select('id').eq('id', audiobook_id).eq('user_id', user_id).execute()
        if not existing.data:
            return jsonify({'error': 'Audiobook not found'}), 404
        supabase.table('audiobooks').update(update_data).eq('id', audiobook_id).execute()
        return jsonify({'success': True})
    except Exception as e:
        print(f'[ERROR] Metadata update failed: {e}')
        return jsonify({'error': 'Failed to update metadata'}), 500


@app.route('/api/audiobooks/<audiobook_id>', methods=['DELETE'])
@optional_auth
def delete_audiobook(audiobook_id):
    """
    Delete an audiobook. Authenticated users only — anonymous devices are
    refused (403) because the trial gate is row-existence on device_id.

    Returns 200 immediately after the DB row is removed. Cloudinary cleanup
    (audio chunks, cover, inline images) runs in a background thread because
    serially deleting 30 chapter audio files synchronously routinely takes
    >15 s — the frontend's axios client gives up at 15 s and the UI never
    sees the success, leaving the deleted book ghost-visible in the library.

    Any Cloudinary deletion that fails silently in the background becomes a
    CDN orphan, which is reaped by scripts/cleanup_orphan_cdn_assets.py.
    """
    user_id = request.user_id
    device_id = request.device_id

    if not user_id and not device_id:
        return jsonify({'error': 'Authentication or X-Device-Id required'}), 401

    # Anonymous users cannot delete their trial book. The anonymous gate is a
    # row-existence check on `audiobooks.device_id` — letting the device
    # delete the row would reopen the gate for unlimited free conversions.
    # The book is claimed (and becomes deletable) when they sign up.
    if not user_id:
        return jsonify({
            'error': 'Sign up to manage your library — your trial book moves to your account automatically.',
            'anonymous_delete_blocked': True,
        }), 403

    try:
        validate_audiobook_id(audiobook_id)
    except ValidationError:
        return jsonify({'error': 'Invalid audiobook ID'}), 400

    try:
        supabase = get_supabase_client()

        # Pull every CDN URL we need to clean up BEFORE deleting the DB row,
        # otherwise we lose the references. Ownership is enforced by the
        # identity filter on the lookup.
        book = _select_with_timing_fallback(
            lambda cols: supabase.table('audiobooks')
            .select(f'id, cover_url, audiobook_chapters({cols})')
            .eq('id', audiobook_id)
            .eq('user_id', user_id)
            .maybe_single().execute(),
            'audiobook delete',
        )
        if not getattr(book, 'data', None):
            return jsonify({'error': 'Audiobook not found'}), 404

        # The shared demo book is live product surface for every user —
        # refuse deletion even from the owning account. Unflag it first
        # (UPDATE audiobooks SET is_demo = FALSE WHERE id = ...) to delete.
        # Separate defensive query: if migration 014 hasn't been applied the
        # is_demo column doesn't exist and this check must not break deletes.
        try:
            demo_check = supabase.table('audiobooks')\
                .select('is_demo')\
                .eq('id', audiobook_id)\
                .maybe_single().execute()
            if getattr(demo_check, 'data', None) and demo_check.data.get('is_demo'):
                return jsonify({'error': 'The sample book cannot be deleted'}), 403
        except Exception as demo_err:
            print(f'[WARN] Demo delete-guard check skipped: {demo_err}')

        cover_url = book.data.get('cover_url')
        chapters = book.data.get('audiobook_chapters', []) or []

        # Delete DB row first → frontend gets a fast response, library
        # updates immediately. Foreign-key cascade on audiobook_chapters
        # cleans up the chapter rows.
        supabase.table('audiobooks').delete()\
            .eq('id', audiobook_id).eq('user_id', user_id).execute()

        # Fire-and-forget Cloudinary cleanup. Daemon thread so it doesn't
        # block the response or hold the request open.
        def _bg_delete_cdn_assets():
            # Audio chapters (resource_type='video')
            for ch in chapters:
                audio_url = ch.get('audio_url')
                if audio_url:
                    try:
                        delete_cloudinary_asset(audio_url, max_retries=1)
                    except Exception as e:
                        print(f'[bg-delete] audio cleanup failed: {e}')

            # Cover art (resource_type='image')
            if cover_url:
                _safe_destroy_image(cover_url)

            # Inline EPUB images (resource_type='image')
            for ch in chapters:
                for ins in (ch.get('image_inserts') or []):
                    img_url = ins.get('url') if isinstance(ins, dict) else None
                    if img_url:
                        _safe_destroy_image(img_url)

            # Karaoke timings (resource_type='raw') — migration 016 onward
            for ch in chapters:
                _safe_destroy_raw(ch.get('word_timings_url'))

            print(f'[bg-delete] Finished CDN cleanup for audiobook {audiobook_id}')

        threading.Thread(target=_bg_delete_cdn_assets, daemon=True).start()

        return jsonify({'success': True})
    except Exception as e:
        print(f'Error deleting audiobook: {e}')
        return jsonify({'error': 'Failed to delete audiobook'}), 500


# CDN-cleanup projections. Both delete paths need every Cloudinary reference
# a book owns; word_timings_url only exists from migration 016, and a delete
# must not 500 in the window between deploying this code and applying it.
_CHAPTER_CLEANUP_COLUMNS = 'audio_url, image_inserts, word_timings_url'
_CHAPTER_CLEANUP_COLUMNS_LEGACY = 'audio_url, image_inserts'


def _select_with_timing_fallback(run_query, label: str):
    """
    Run a cleanup select that names word_timings_url, retrying without it on a
    pre-016 database. `run_query` takes the chapter projection and returns the
    executed response.
    """
    try:
        return run_query(_CHAPTER_CLEANUP_COLUMNS)
    except Exception as col_err:
        if 'word_timings_url' not in str(col_err):
            raise
        print(f'[WARN] word_timings_url column missing during {label}; '
              f'timings JSON will be left for the orphan sweep '
              f'(apply migration 016)')
        return run_query(_CHAPTER_CLEANUP_COLUMNS_LEGACY)


def _safe_destroy_raw(cloudinary_url: str) -> None:
    """
    Best-effort delete of a raw asset (a chapter's word-timings JSON).

    Raw public_ids KEEP their file extension — `word_timings/<id>_0.json`, not
    `word_timings/<id>_0` — so extract_public_id() cannot be reused here: it
    strips the extension (correct for the .mp3/.jpg assets it was built for)
    and destroy() would silently no-op on a public_id that doesn't exist.

    Failures are swallowed and printed; scripts/cleanup_orphan_cdn_assets.py
    reaps anything that falls through.
    """
    if not cloudinary_url or '/upload/' not in cloudinary_url:
        return
    try:
        from urllib.parse import unquote
        path_after_upload = unquote(cloudinary_url).split('/upload/', 1)[1]
        # Drop the optional version segment (v1234567890/) but keep everything
        # else, extension included.
        segments = path_after_upload.split('/')
        if segments and re.fullmatch(r'v\d+', segments[0]):
            segments = segments[1:]
        public_id = '/'.join(segments)
        if not public_id:
            return
        result = cloudinary.uploader.destroy(public_id, resource_type='raw', invalidate=True)
        # destroy() does NOT raise on a public_id that doesn't exist — it returns
        # {'result': 'not found'}. Swallowing that would let a derivation bug leak
        # every timings file forever, silently. Log anything that isn't 'ok'.
        outcome = (result or {}).get('result')
        if outcome != 'ok':
            print(f'[bg-delete] word_timings destroy returned {outcome!r} for '
                  f'public_id={public_id!r} — file may be orphaned')
    except Exception as e:
        print(f'[bg-delete] word_timings cleanup failed for {cloudinary_url}: {e}')


def _safe_destroy_image(cloudinary_url: str) -> None:
    """
    Best-effort delete of an image asset (cover or inline EPUB image).

    delete_cloudinary_asset() is hardcoded to resource_type='video' (it was
    built for audio MP3s), so we can't reuse it for images. Failures are
    swallowed and printed — the orphan cleanup script will reap anything
    that falls through.
    """
    try:
        public_id = extract_public_id(cloudinary_url)
        if not public_id:
            return
        cloudinary.uploader.destroy(public_id, resource_type='image', invalidate=True)
    except Exception as e:
        print(f'[bg-delete] image cleanup failed for {cloudinary_url}: {e}')

# ==================== Anonymous Trial → Account Claim ====================

@app.route('/api/anonymous/claim', methods=['POST'])
@require_auth
def claim_anonymous_book():
    """
    Transfer ownership of an anonymous trial audiobook (and its in-flight
    conversion task, if any) from a device_id to the authenticated user.

    Called by AuthContext immediately after any successful sign-in or sign-up.
    Idempotent: safe to call when there's nothing to claim (returns claimed=0).

    The audiobook's CHECK constraint (chk_audiobooks_identity) is satisfied by
    the single UPDATE statement — Postgres evaluates row constraints after the
    full SET clause is applied, so flipping both columns in one statement is
    atomic and valid.

    Security note: this endpoint accepts an arbitrary device_id from the body
    and trusts it. In theory a motivated attacker who knows another device's
    UUID could "claim" their anonymous trial book. The blast radius is one
    trial audiobook with no PII attached — accepted risk for v1.
    """
    user_id = request.user_id
    data = request.get_json() or {}
    device_id = (data.get('device_id') or '').strip()

    if not device_id:
        return jsonify({'error': 'device_id required'}), 400
    if not (16 <= len(device_id) <= 128) or not all(c.isalnum() or c == '-' for c in device_id):
        return jsonify({'error': 'Invalid device_id'}), 400

    try:
        supabase = get_supabase_client()

        # Move audiobooks. Single UPDATE so the CHECK constraint sees the
        # final state (user_id set, device_id null) without a transient
        # both-null or both-set violation.
        audiobook_update = supabase.table('audiobooks')\
            .update({'user_id': user_id, 'device_id': None})\
            .eq('device_id', device_id)\
            .execute()

        # Best-effort claim of any still-in-flight conversion task. If the
        # worker is mid-save when this runs, the conversion will still write
        # under device_id (see TOCTOU note in journal) — that's acceptable
        # for v1; user can re-sync the library on next focus.
        try:
            supabase.table('conversion_tasks')\
                .update({'user_id': user_id, 'device_id': None})\
                .eq('device_id', device_id)\
                .execute()
        except Exception as task_err:
            # Non-fatal — the audiobook is what matters for the user.
            print(f'[claim] conversion_tasks update failed: {task_err}')

        # Move the device's push token onto the account (only if the account
        # has none yet — the SIGNED_IN handler registers one too), then drop
        # the device row so a conversion claimed mid-flight can't notify twice.
        try:
            tok = supabase.table('device_push_tokens').select('expo_push_token')\
                .eq('device_id', device_id).limit(1).execute()
            if tok.data:
                prof = supabase.table('profiles').select('expo_push_token')\
                    .eq('id', user_id).limit(1).execute()
                if prof.data and not prof.data[0].get('expo_push_token'):
                    supabase.table('profiles')\
                        .update({'expo_push_token': tok.data[0]['expo_push_token']})\
                        .eq('id', user_id).execute()
                supabase.table('device_push_tokens').delete().eq('device_id', device_id).execute()
        except Exception as tok_err:
            # Non-fatal; the table may not exist until migration 011 is run.
            print(f'[claim] device push token move skipped: {tok_err}')

        claimed_count = len(audiobook_update.data or [])
        print(f'[claim] Moved {claimed_count} audiobook(s) from device {device_id[:8]}... to user {user_id}')
        return jsonify({
            'success': True,
            'claimed': claimed_count,
        })
    except Exception as e:
        print(f'[claim] failed: {e}')
        return jsonify({'error': 'Claim failed'}), 500


# ==================== Account Management Endpoints ====================

@app.route('/api/account', methods=['DELETE'])
@require_auth
def delete_account():
    """
    Delete user account and all associated data.
    This will:
    1. Delete all audio files from Cloudinary
    2. Cancel any active Stripe subscriptions
    3. Delete all audiobooks and chapters from database
    4. Delete user profile from database

    SECURITY: Requires confirmation string to prevent accidental deletion.
    """
    try:
        user_id = request.user_id

        # SECURITY: Require explicit confirmation
        data = request.get_json() or {}
        if data.get('confirmation') != 'DELETE_MY_ACCOUNT':
            return jsonify({
                'error': 'Account deletion requires confirmation',
                'message': 'Please include {"confirmation": "DELETE_MY_ACCOUNT"} in request body'
            }), 400

        supabase = get_supabase_client()

        # SECURITY: Log account deletion attempt
        audit_log.log_account_deletion(user_id)

        print(f'[ACCOUNT] Starting account deletion for user (ID masked)')

        # Step 1: Pull every CDN URL we need to clean up BEFORE deleting the
        # rows, otherwise the references are gone. Mirrors delete_audiobook():
        # the frontend's axios client times out at 15 s, so we must NOT delete
        # hundreds of Cloudinary assets synchronously inside the request — that
        # was the bug (the loop never reached the DB/auth deletion below).
        audiobooks_response = _select_with_timing_fallback(
            lambda cols: supabase.table('audiobooks')
            .select(f'id, title, cover_url, audiobook_chapters({cols})')
            .eq('user_id', user_id)
            .execute(),
            'account delete',
        )

        audiobooks = audiobooks_response.data if audiobooks_response.data else []
        print(f'📚 Found {len(audiobooks)} audiobooks to delete')

        # Flatten all CDN references up front while the rows still exist.
        audio_urls = []
        cover_urls = []
        image_urls = []
        timing_urls = []
        for book in audiobooks:
            if book.get('cover_url'):
                cover_urls.append(book['cover_url'])
            for ch in (book.get('audiobook_chapters') or []):
                if ch.get('audio_url'):
                    audio_urls.append(ch['audio_url'])
                if ch.get('word_timings_url'):
                    timing_urls.append(ch['word_timings_url'])
                for ins in (ch.get('image_inserts') or []):
                    img_url = ins.get('url') if isinstance(ins, dict) else None
                    if img_url:
                        image_urls.append(img_url)

        # Step 2: Cancel Stripe subscription if exists (web subs only; Apple/
        # Google IAP subs are managed by the stores and expire on their own).
        print(f'💳 Attempting to cancel Stripe subscription...')
        subscription_cancelled = StripeService.cancel_user_subscription(user_id)
        if subscription_cancelled:
            print(f'✅ Stripe subscription handling completed')
        else:
            print(f'⚠️ Issue with Stripe subscription cancellation (continuing anyway)')

        # Step 3: Delete all audiobooks (cascades to chapters), then profile.
        supabase.table('audiobooks').delete().eq('user_id', user_id).execute()
        print(f'🗑️ Deleted audiobooks from database')

        supabase.table('profiles').delete().eq('id', user_id).execute()

        # Step 4: Delete Supabase Auth user (must be last — invalidates the token)
        try:
            supabase.auth.admin.delete_user(user_id)
            print(f'✅ Supabase Auth user deleted')
        except Exception as auth_delete_error:
            print(f'⚠️ Failed to delete Supabase Auth user: {auth_delete_error} (continuing)')

        # Step 5: Fire-and-forget Cloudinary cleanup in a daemon thread so the
        # request returns well within the 15 s client timeout. Anything that
        # fails here becomes a CDN orphan, reaped by
        # scripts/cleanup_orphan_cdn_assets.py.
        def _bg_delete_account_assets():
            for audio_url in audio_urls:
                try:
                    delete_cloudinary_asset(audio_url, max_retries=1)
                except Exception as e:
                    print(f'[bg-delete] audio cleanup failed: {e}')
            for img_url in cover_urls + image_urls:
                _safe_destroy_image(img_url)
            for timing_url in timing_urls:
                _safe_destroy_raw(timing_url)
            print(f'[bg-delete] Finished CDN cleanup for deleted account '
                  f'({len(audio_urls)} audio, {len(cover_urls)} covers, '
                  f'{len(image_urls)} images, {len(timing_urls)} timings)')

        threading.Thread(target=_bg_delete_account_assets, daemon=True).start()

        print(f'✅ Account deletion completed for user: {user_id}')

        # Return success with summary (CDN cleanup is queued asynchronously).
        return jsonify({
            'success': True,
            'message': 'Account deleted successfully',
            'summary': {
                'audiobooks_deleted': len(audiobooks),
                'audio_files_queued': len(audio_urls),
                'subscription_cancelled': subscription_cancelled
            }
        }), 200

    except Exception as e:
        print(f'❌ Error deleting account: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'Failed to delete account'}), 500

# ==================== Stripe Payment Endpoints ====================

@app.route('/api/create-checkout-session', methods=['POST'])
@require_auth
def create_checkout_session():
    """Create a Stripe Checkout session for subscription purchase"""
    try:
        user_id = request.user_id
        data = request.get_json()
        tier = data.get('tier')

        if not tier or tier not in ['starter', 'pro', 'enterprise']:
            return jsonify({'error': 'Invalid tier'}), 400

        # Get platform for redirect URL selection
        platform = data.get('platform', 'web')

        # Get user email from profile
        profile = get_user_profile(user_id)
        if not profile:
            return jsonify({'error': 'User profile not found'}), 404

        email = profile.get('email')

        # Create checkout session with platform-aware redirects
        session_data = StripeService.create_checkout_session(user_id, email, tier, platform=platform)

        return jsonify(session_data)

    except Exception as e:
        print(f'Error creating checkout session: {e}')
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to create checkout session'}), 500

def _is_entitlement_active(entitlement):
    """An entitlement is active if it has no expiry, or its expiry is in the future."""
    if not entitlement:
        return False
    expires = entitlement.get('expires_date')
    if expires is None:
        return True
    try:
        if isinstance(expires, str):
            expires_dt = datetime.fromisoformat(expires.replace('Z', '+00:00'))
        else:
            return False
        if expires_dt.tzinfo is None:
            expires_dt = expires_dt.replace(tzinfo=dt_timezone.utc)
        return expires_dt > datetime.now(dt_timezone.utc)
    except Exception:
        return False


def _is_sandbox_entitlement(subscriber, entitlement):
    """True if the purchase granting this entitlement was a sandbox (TestFlight) one.

    v1 entitlements carry only `product_identifier`; `is_sandbox` lives on the
    matching record in `subscriptions` (or `non_subscriptions` for one-time
    purchases like lifetime). Mirrors the webhook's SANDBOX rule: a TestFlight
    purchase must never unlock a paid tier.
    """
    product = (entitlement or {}).get('product_identifier')
    if not product:
        return False
    sub = (subscriber.get('subscriptions') or {}).get(product)
    if sub is not None:
        return bool(sub.get('is_sandbox'))
    purchases = (subscriber.get('non_subscriptions') or {}).get(product) or []
    return bool(purchases) and all(p.get('is_sandbox') for p in purchases)


def _tier_from_rc_subscriber(rc_data):
    """Derive tier from a RevenueCat subscriber response.

    'lifetime' (one-time purchase, never expires) outranks the subscriptions
    so an unrelated sub expiring can't mask it. Then 'pro' > 'starter' > 'free'.
    Entitlements granted by a sandbox purchase are ignored.
    """
    subscriber = (rc_data or {}).get('subscriber', {}) or {}
    entitlements = subscriber.get('entitlements', {}) or {}
    for tier in ('lifetime', 'pro', 'starter'):
        ent = entitlements.get(tier)
        if not _is_entitlement_active(ent):
            continue
        if _is_sandbox_entitlement(subscriber, ent):
            print(f'[rc] {tier} entitlement is from a sandbox purchase — not synced')
            continue
        return tier
    return 'free'


def _fetch_rc_tier(user_id):
    """Best-effort tier lookup against the RevenueCat REST API.

    Returns the entitled tier name, or None if RC is unreachable /
    unconfigured — callers must fall back to their own default.
    """
    api_key = os.environ.get('REVENUECAT_SECRET_KEY', '')
    if not api_key:
        return None
    try:
        resp = http_requests.get(
            f'https://api.revenuecat.com/v1/subscribers/{user_id}',
            headers={'Authorization': f'Bearer {api_key}'},
            timeout=8,
        )
        if resp.status_code != 200:
            return None
        return _tier_from_rc_subscriber(resp.json())
    except Exception as e:
        print(f'[rc] tier lookup failed for {user_id}: {e}')
        return None


@app.route('/api/sync-mobile-purchase', methods=['POST'])
@require_auth
def sync_mobile_purchase():
    """
    Called by the mobile app after a successful RevenueCat purchase or restore.

    Design:
    - RevenueCat webhook (/api/revenuecat-webhook) is the authoritative source of truth.
      This endpoint is a best-effort synchronous refresh so the UI can update immediately
      rather than waiting for the webhook round-trip.
    - We verify entitlements with the RevenueCat REST API. The client-supplied `tier` is
      only a hint used for logging; we never trust it for the final Supabase write.
    - Transient failures (404 race, timeout, 5xx) return non-500 status codes so the
      client can retry or fall back to polling the profile — the webhook will correct
      Supabase shortly regardless.
    """
    user_id = request.user_id
    data = request.get_json() or {}
    client_hint_tier = data.get('tier', 'free')

    REVENUECAT_API_KEY = os.environ.get('REVENUECAT_SECRET_KEY', '')
    if not REVENUECAT_API_KEY:
        print('[sync-mobile-purchase] REVENUECAT_SECRET_KEY not configured — relying on webhook')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'verification_unavailable',
            'message': 'Purchase recorded by store; server will sync shortly.',
        }), 202

    rc_url = f'https://api.revenuecat.com/v1/subscribers/{user_id}'
    try:
        resp = http_requests.get(
            rc_url,
            headers={
                'Authorization': f'Bearer {REVENUECAT_API_KEY}',
                'Content-Type': 'application/json',
            },
            timeout=8,
        )
    except http_requests.exceptions.RequestException as e:
        print(f'[sync-mobile-purchase] RC network error for {user_id}: {e}')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'verification_timeout',
            'message': 'Could not reach RevenueCat; webhook will sync shortly.',
        }), 202

    if resp.status_code == 404:
        # Race condition: subscriber was just created on the device but RC hasn't
        # propagated the record to the REST API yet. Normal right after first purchase.
        print(f'[sync-mobile-purchase] RC 404 for {user_id} (hint tier={client_hint_tier}) — webhook will sync')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'subscriber_not_found',
            'message': 'Purchase is being registered; try again shortly.',
        }), 202

    if resp.status_code == 401 or resp.status_code == 403:
        # Our misconfiguration, not the buyer's problem — the store has already
        # charged them and the webhook still writes the tier. Same pending shape
        # as every other transient case so the client polls the profile.
        print(f'[sync-mobile-purchase] RC auth error {resp.status_code} — check REVENUECAT_SECRET_KEY '
              f'(needs a v1 secret key): {resp.text[:200]}')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'verification_unavailable',
            'message': 'Purchase recorded by store; server will sync shortly.',
        }), 202

    if resp.status_code >= 500:
        print(f'[sync-mobile-purchase] RC 5xx {resp.status_code} — webhook will sync')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'rc_unavailable',
            'message': 'RevenueCat temporarily unavailable; webhook will sync shortly.',
        }), 202

    if resp.status_code != 200:
        print(f'[sync-mobile-purchase] RC unexpected {resp.status_code}: {resp.text[:200]}')
        return jsonify({'error': 'Failed to verify purchase'}), 502

    try:
        rc_data = resp.json()
    except ValueError as e:
        print(f'[sync-mobile-purchase] Invalid JSON from RC: {e}')
        return jsonify({'error': 'Invalid response from verification service'}), 502

    tier = _tier_from_rc_subscriber(rc_data)

    if tier == 'free':
        # This endpoint only ever upgrades. RC knowing no (production) entitlement
        # can mean a sandbox purchase, a not-yet-propagated one, or a Stripe web
        # subscriber pressing Restore — none of which should write 'free' over the
        # profile. Downgrades belong to the webhook (EXPIRATION).
        print(f'[sync-mobile-purchase] No production entitlement for {user_id} '
              f'(hint was {client_hint_tier}) — leaving profile as-is')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'no_active_entitlement',
            'message': 'No active store entitlement found yet.',
        }), 202

    from tier_limits import limits_for
    limits = limits_for(tier)

    try:
        supabase_client = get_supabase_client()
        update_payload = {
            'subscription_tier': tier,
            'max_audiobooks': limits['max_audiobooks'],
            'max_monthly_conversions': limits['max_monthly_conversions'],
        }
        if tier != 'free':
            update_payload['subscription_status'] = 'active'
            update_payload['subscription_cancel_at_period_end'] = False
        supabase_client.table('profiles').update(update_payload).eq('id', user_id).execute()
    except Exception as e:
        # The webhook is authoritative for Supabase state; a transient write
        # failure here shouldn't block the user — return pending so the client
        # polls and picks up the webhook's update instead of surfacing an error.
        print(f'[sync-mobile-purchase] Supabase update failed for {user_id}: {e} — webhook will sync')
        return jsonify({
            'success': False,
            'pending': True,
            'reason': 'supabase_write_failed',
            'message': 'Purchase recorded; server will sync shortly.',
        }), 202

    print(f'[sync-mobile-purchase] Updated {user_id} to tier={tier} (hint was {client_hint_tier})')
    return jsonify({'tier': tier, 'success': True})


@app.route('/api/revenuecat-webhook', methods=['POST'])
def revenuecat_webhook():
    """
    Webhook endpoint for RevenueCat server-to-server notifications.
    Handles subscription lifecycle events (purchase, renewal, cancellation,
    expiration, billing issues) so Supabase stays in sync with Apple/Google.
    """
    # Verify shared secret
    webhook_secret = os.environ.get('REVENUECAT_WEBHOOK_SECRET', '')
    auth_header = request.headers.get('Authorization', '')
    if not webhook_secret or auth_header != f'Bearer {webhook_secret}':
        return jsonify({'error': 'Unauthorized'}), 401

    try:
        payload = request.get_json() or {}
        event = payload.get('event', {})
        event_type = event.get('type', '')
        app_user_id = event.get('app_user_id', '')

        # TRANSFER events move entitlements between app_user_ids (Restore
        # Purchases / re-login / device migration). They carry
        # `transferred_to` / `transferred_from` arrays INSTEAD of a top-level
        # `app_user_id`, so the generic guard below would 400 them — and
        # RevenueCat then retries the rejected event for an hour (observed
        # 2026-06-11: six retries 10:28→11:25). Handle them explicitly:
        # re-derive each gaining user's tier from RC and ack 200 so the retry
        # storm stops.
        if event_type == 'TRANSFER':
            if (event.get('environment') or '').upper() == 'SANDBOX':
                print('[revenuecat-webhook] Ignoring SANDBOX TRANSFER (no DB write)')
                return jsonify({'success': True, 'ignored': 'sandbox'})
            to_ids = event.get('transferred_to') or []
            if not to_ids:
                print('[revenuecat-webhook] TRANSFER with no transferred_to — acking')
                return jsonify({'success': True, 'ignored': 'transfer_no_target'})
            from tier_limits import limits_for
            supabase_client = get_supabase_client()
            for uid in to_ids:
                tier = _fetch_rc_tier(uid)
                if tier is None:
                    # RC unreachable / key unset — leave state as-is; a later
                    # purchase/renewal webhook or the sync endpoint corrects it.
                    print(f'[revenuecat-webhook] TRANSFER to {uid}: tier unresolved (RC unavailable) — skipping write')
                    continue
                limits = limits_for(tier)
                supabase_client.table('profiles').update({
                    'subscription_tier': tier,
                    'subscription_status': 'active' if tier != 'free' else 'inactive',
                    'subscription_cancel_at_period_end': False,
                    'max_audiobooks': limits['max_audiobooks'],
                    'max_monthly_conversions': limits['max_monthly_conversions'],
                }).eq('id', uid).execute()
                print(f'[revenuecat-webhook] TRANSFER → set {uid} to {tier}')
            return jsonify({'success': True})

        if not app_user_id:
            print(f'[revenuecat-webhook] No app_user_id in event: {event_type}')
            return jsonify({'error': 'Missing app_user_id'}), 400

        print(f'[revenuecat-webhook] Event: {event_type} for user: {app_user_id}')

        # Ignore SANDBOX (TestFlight / store-sandbox) events entirely — they must
        # never mutate real subscriber state. Sandbox subscriptions renew on an
        # accelerated timer and expire within ~30 min; without this guard a
        # tester's sandbox EXPIRATION would downgrade a real paying production
        # subscriber to free. RevenueCat tags every event with `environment`.
        environment = (event.get('environment') or '').upper()
        if environment == 'SANDBOX':
            print(f'[revenuecat-webhook] Ignoring SANDBOX {event_type} for {app_user_id} (no DB write)')
            return jsonify({'success': True, 'ignored': 'sandbox'})

        from tier_limits import limits_for

        supabase_client = get_supabase_client()

        # Determine the entitled tier from the event's entitlements.
        # 'lifetime' is the one-time purchase (RC non-consumable) and outranks
        # the subscriptions.
        entitlement_ids = list((event.get('entitlement_ids') or []))
        tier = next((t for t in ('lifetime', 'pro', 'starter') if t in entitlement_ids), 'free')

        # NON_RENEWING_PURCHASE is how RevenueCat reports a one-time purchase
        # (the lifetime tier) — it activates like a subscription purchase.
        if event_type in ('INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE',
                          'UNCANCELLATION', 'NON_RENEWING_PURCHASE'):
            limits = limits_for(tier)
            supabase_client.table('profiles').update({
                'subscription_tier': tier,
                'subscription_status': 'active',
                'subscription_cancel_at_period_end': False,
                'max_audiobooks': limits['max_audiobooks'],
                'max_monthly_conversions': limits['max_monthly_conversions'],
            }).eq('id', app_user_id).execute()
            print(f'[revenuecat-webhook] Activated {tier} for {app_user_id}')

        elif event_type == 'CANCELLATION':
            # User cancelled — still has access until period end
            supabase_client.table('profiles').update({
                'subscription_cancel_at_period_end': True,
            }).eq('id', app_user_id).execute()
            print(f'[revenuecat-webhook] Marked cancel-at-period-end for {app_user_id}')

        elif event_type == 'EXPIRATION':
            # An EXPIRATION only says ONE entitlement lapsed — the user may
            # still hold another (e.g. a lifetime purchase outliving a sub).
            # Re-derive the remaining tier from RC; fall back to free if RC
            # is unreachable (a wrongly-downgraded user can Restore Purchases).
            remaining_tier = _fetch_rc_tier(app_user_id) or 'free'
            limits = limits_for(remaining_tier)
            supabase_client.table('profiles').update({
                'subscription_tier': remaining_tier,
                'subscription_status': 'active' if remaining_tier != 'free' else 'inactive',
                'subscription_cancel_at_period_end': False,
                'max_audiobooks': limits['max_audiobooks'],
                'max_monthly_conversions': limits['max_monthly_conversions'],
            }).eq('id', app_user_id).execute()
            print(f'[revenuecat-webhook] Expired — {app_user_id} now {remaining_tier}')

        elif event_type == 'BILLING_ISSUE':
            supabase_client.table('profiles').update({
                'subscription_status': 'past_due',
            }).eq('id', app_user_id).execute()
            print(f'[revenuecat-webhook] Billing issue for {app_user_id}')

        else:
            print(f'[revenuecat-webhook] Unhandled event type: {event_type}')

        return jsonify({'success': True})

    except Exception as e:
        print(f'[revenuecat-webhook] Error: {e}')
        return jsonify({'error': 'Webhook processing failed'}), 500


@app.route('/api/create-portal-session', methods=['POST'])
@require_auth
def create_portal_session():
    """Create a Stripe billing portal session for subscription management"""
    try:
        user_id = request.user_id

        # Get platform for redirect URL selection
        data = request.get_json() or {}
        platform = data.get('platform', 'web')

        # Create portal session with platform-aware return URL
        session_data = StripeService.create_portal_session(user_id, platform=platform)

        return jsonify(session_data)

    except ValueError as e:
        print(f'Error creating portal session: {e}')
        # SECURITY: ValueError from StripeService is safe to return (user-friendly message)
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        print(f'Error creating portal session: {e}')
        # SECURITY: Don't expose internal error details
        return jsonify({'error': 'Failed to create portal session'}), 500

@app.route('/api/webhook', methods=['POST'])
def stripe_webhook():
    """Handle Stripe webhook events"""
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')
    webhook_secret = os.environ.get('STRIPE_WEBHOOK_SECRET')

    if not webhook_secret:
        print('❌ STRIPE_WEBHOOK_SECRET not configured')
        return jsonify({'error': 'Webhook secret not configured'}), 500

    try:
        # Verify webhook signature
        event = stripe.Webhook.construct_event(
            payload, sig_header, webhook_secret
        )
        print(f'✅ Webhook signature verified: {event["type"]}')

    except ValueError as e:
        # Invalid payload
        print(f'❌ Invalid webhook payload: {e}')
        return jsonify({'error': 'Invalid payload'}), 400
    except stripe.error.SignatureVerificationError as e:
        # Invalid signature
        print(f'❌ Invalid webhook signature: {e}')
        return jsonify({'error': 'Invalid signature'}), 400

    # Check if event already processed (idempotency)
    event_id = event['id']
    if StripeService.check_webhook_processed(event_id):
        print(f'⚠️ Webhook already processed: {event_id}')
        return jsonify({'status': 'already_processed'}), 200

    # Handle the event
    event_type = event['type']

    try:
        if event_type == 'checkout.session.completed':
            session = event['data']['object']
            StripeService.handle_checkout_completed(session)

        elif event_type == 'customer.subscription.created':
            subscription = event['data']['object']
            StripeService.handle_subscription_updated(subscription)

        elif event_type == 'customer.subscription.updated':
            subscription = event['data']['object']
            StripeService.handle_subscription_updated(subscription)

        elif event_type == 'customer.subscription.deleted':
            subscription = event['data']['object']
            StripeService.handle_subscription_deleted(subscription)

        elif event_type == 'invoice.payment_succeeded':
            invoice = event['data']['object']
            StripeService.handle_invoice_payment_succeeded(invoice)

        elif event_type == 'invoice.payment_failed':
            invoice = event['data']['object']
            StripeService.handle_invoice_payment_failed(invoice)

        else:
            print(f'ℹ️ Unhandled webhook event type: {event_type}')

        # Mark event as processed
        StripeService.mark_webhook_processed(event_id)

        return jsonify({'status': 'success'}), 200

    except Exception as e:
        import traceback
        print(f'Error processing webhook: {e}')
        traceback.print_exc()
        # SECURITY: Don't expose internal error details to webhooks
        return jsonify({'error': 'Webhook processing failed'}), 500

if __name__ == '__main__':
    print("=" * 60)
    print("⚠️  DEVELOPMENT SERVER MODE")
    print("=" * 60)
    print("For production deployment, use Gunicorn:")
    print("  gunicorn -c gunicorn.conf.py wsgi:app")
    print("")
    print("Starting single-process development server...")
    print("=" * 60)

    # Start queue worker for dev mode (in Gunicorn this runs via post_worker_init).
    # Set DISABLE_QUEUE_WORKER=true in your local .env to skip this — the API
    # endpoints will still serve requests, but this instance won't claim
    # queued conversion tasks.  Use this when running locally against the
    # production Supabase project so your laptop doesn't grab real users'
    # conversions.  Production (Render) does not set this env var.
    if os.environ.get('DISABLE_QUEUE_WORKER', '').strip().lower() in ('1', 'true', 'yes'):
        print("[!] DISABLE_QUEUE_WORKER set — skipping queue worker, requeue, and cleanup")
    else:
        try:
            from queue_manager import QueueWorker, requeue_stuck_tasks as _requeue
            _requeue(get_supabase_client())
            _dev_worker = QueueWorker(get_supabase_client())
            _dev_worker.start()
            print("[+] Queue worker started (dev mode)")
        except Exception as e:
            print(f"[!] Error starting queue worker: {e}")

    # Initialize voice cache on startup
    try:
        print("[*] Initializing voice cache...")
        vm = get_voice_manager()
        voices = asyncio.run(vm.get_voices())
        print(f"[+] Voice cache initialized with {len(voices)} voices")
    except Exception as e:
        print(f"[!] Error initializing voice cache: {e}")
        print("    Will use fallback voices")

    # Clean up old tasks on startup — also gated by DISABLE_QUEUE_WORKER
    # so a local dev instance pointed at production Supabase doesn't delete
    # tasks that production might still be working on.
    if os.environ.get('DISABLE_QUEUE_WORKER', '').strip().lower() not in ('1', 'true', 'yes'):
        try:
            print("[*] Cleaning up old conversion tasks...")
            deleted_count = task_manager.cleanup_old_tasks(hours=24)
            if deleted_count > 0:
                print(f"[+] Cleaned up {deleted_count} old tasks")
        except Exception as e:
            print(f"[!] Error during task cleanup: {e}")

    print("")
    print("Server starting on http://localhost:8080")
    print("=" * 60)

    # Start development server (debug=False for production-like behavior)
    app.run(debug=False, host='0.0.0.0', port=8080, threaded=True)