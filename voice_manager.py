"""
Voice Manager for Microsoft Edge TTS
Handles dynamic fetching, caching, and management of TTS voices
"""
import edge_tts
import json
import os
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import asyncio

# Fallback hardcoded voices (used when Microsoft API is unavailable)
FALLBACK_VOICES = {
    "en-GB-SoniaNeural": {
        "id": "en-GB-SoniaNeural",
        "name": "Sonia (UK Female - Storytelling)",
        "description": "Natural British voice, perfect for storytelling",
        "locale": "en-GB",
        "gender": "Female",
        "status": "active"
    },
    "en-US-TonyNeural": {
        "id": "en-US-TonyNeural",
        "name": "Tony (US Male - Mature Narrator)",
        "description": "Deep, authoritative American voice",
        "locale": "en-US",
        "gender": "Male",
        "status": "active"
    },
    "en-US-DavisNeural": {
        "id": "en-US-DavisNeural",
        "name": "Davis (US Male - Smooth Narrator)",
        "description": "Smooth, professional narration",
        "locale": "en-US",
        "gender": "Male",
        "status": "active"
    },
    "en-US-AndrewNeural": {
        "id": "en-US-AndrewNeural",
        "name": "Andrew (US Male - Expressive)",
        "description": "Dynamic and expressive delivery",
        "locale": "en-US",
        "gender": "Male",
        "status": "active"
    },
    "en-US-EmmaNeural": {
        "id": "en-US-EmmaNeural",
        "name": "Emma (US Female - Cheerful)",
        "description": "Warm, friendly female voice",
        "locale": "en-US",
        "gender": "Female",
        "status": "active"
    }
}


class VoiceManager:
    """Manages TTS voices with caching and fallback support"""

    def __init__(
        self,
        cache_file: str = "voice_cache.json",
        cache_ttl_hours: int = 168,
        filter_neural_only: bool = True,
        filter_locales: List[str] = None
    ):
        """
        Initialize VoiceManager

        Args:
            cache_file: Path to JSON file for persistent cache
            cache_ttl_hours: Cache time-to-live in hours (default 24)
            filter_neural_only: Only include Neural voices (default True)
            filter_locales: List of locale prefixes to include (e.g., ['en'] for English)
        """
        self.cache_file = cache_file
        self.cache_ttl_hours = cache_ttl_hours
        self.filter_neural_only = filter_neural_only
        self.filter_locales = filter_locales or ['en']

        # In-memory cache
        self._voice_cache: Dict[str, Dict] = {}
        self._cache_timestamp: Optional[datetime] = None

        # Load cache from file on initialization
        self._load_cache_from_file()

    def _load_cache_from_file(self) -> bool:
        """Load voice cache from JSON file"""
        try:
            if not os.path.exists(self.cache_file):
                return False

            with open(self.cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Validate cache timestamp
            cache_time_str = data.get('timestamp')
            if not cache_time_str:
                return False

            cache_time = datetime.fromisoformat(cache_time_str)
            cache_age = datetime.now() - cache_time

            if cache_age > timedelta(hours=self.cache_ttl_hours):
                print(f"[!] Voice cache expired (age: {cache_age}), will refresh")
                return False

            # Load voices into memory
            self._voice_cache = data.get('voices', {})
            self._cache_timestamp = cache_time

            print(f"[+] Loaded {len(self._voice_cache)} voices from cache (age: {cache_age})")
            return True

        except Exception as e:
            print(f"[!] Error loading voice cache: {e}")
            return False

    def _save_cache_to_file(self) -> bool:
        """Save voice cache to JSON file"""
        try:
            data = {
                'timestamp': datetime.now().isoformat(),
                'voices': self._voice_cache
            }

            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            print(f"[+] Saved {len(self._voice_cache)} voices to cache file")
            return True

        except Exception as e:
            print(f"[!] Error saving voice cache: {e}")
            return False

    async def fetch_voices_from_microsoft(self) -> List[Dict]:
        """
        Fetch voices from Microsoft Edge TTS API

        Returns:
            List of voice dictionaries with metadata
        """
        try:
            print("[*] Fetching voices from Microsoft Edge TTS API...")
            voices = await edge_tts.list_voices()

            # Filter and transform voices
            filtered_voices = []
            for voice in voices:
                # Apply filters
                if self.filter_neural_only and 'Neural' not in voice.get('ShortName', ''):
                    continue

                locale = voice.get('Locale', '')
                if self.filter_locales:
                    if not any(locale.startswith(prefix) for prefix in self.filter_locales):
                        continue

                # Transform to our format
                voice_data = {
                    'id': voice.get('ShortName', ''),
                    'name': self._create_display_name(voice),
                    'description': self._create_description(voice),
                    'locale': locale,
                    'gender': voice.get('Gender', 'Unknown'),
                    'status': 'active'
                }

                filtered_voices.append(voice_data)

            print(f"[+] Fetched {len(filtered_voices)} voices from Microsoft API")
            return filtered_voices

        except Exception as e:
            print(f"[-] Error fetching voices from Microsoft: {e}")
            return []

    def _create_display_name(self, voice: Dict) -> str:
        """
        Create a friendly display name from voice metadata

        Args:
            voice: Raw voice data from edge_tts

        Returns:
            Formatted display name (e.g., "Sonia (UK Female)")
        """
        # Extract base name (e.g., "en-GB-SoniaNeural" -> "Sonia")
        short_name = voice.get('ShortName', '')
        parts = short_name.split('-')
        base_name = parts[-1].replace('Neural', '') if len(parts) > 0 else 'Voice'

        # Get locale info
        locale = voice.get('Locale', '')
        locale_parts = locale.split('-')
        country_code = locale_parts[-1] if len(locale_parts) > 1 else ''

        # Map country codes to friendly names
        country_map = {
            'US': 'US',
            'GB': 'UK',
            'AU': 'AU',
            'CA': 'CA',
            'IN': 'IN',
            'IE': 'IE',
            'NZ': 'NZ',
            'ZA': 'ZA'
        }
        country = country_map.get(country_code, country_code)

        # Get gender
        gender = voice.get('Gender', '')

        # Format: "Name (Country Gender)"
        if country and gender:
            return f"{base_name} ({country} {gender})"
        elif country:
            return f"{base_name} ({country})"
        else:
            return base_name

    def _create_description(self, voice: Dict) -> str:
        """
        Create a description for the voice

        Args:
            voice: Raw voice data from edge_tts

        Returns:
            Description string
        """
        locale = voice.get('Locale', '')
        voice_type = voice.get('VoiceType', 'Neural')

        # Create description based on locale and type
        locale_desc = {
            'en-US': 'American English',
            'en-GB': 'British English',
            'en-AU': 'Australian English',
            'en-CA': 'Canadian English',
            'en-IN': 'Indian English',
            'en-IE': 'Irish English',
            'en-NZ': 'New Zealand English',
            'en-ZA': 'South African English'
        }.get(locale, 'English')

        return f"{locale_desc} {voice_type} voice"

    def _filter_voices(self, voices: List[Dict]) -> List[Dict]:
        """
        Additional filtering logic (if needed)

        Args:
            voices: List of voice dictionaries

        Returns:
            Filtered list of voices
        """
        # Currently filtering happens in fetch_voices_from_microsoft
        # This method is kept for future extension
        return voices

    async def get_voices(self, force_refresh: bool = False) -> List[Dict]:
        """
        Get list of available voices (from cache or API)

        Args:
            force_refresh: Force fetching from API even if cache is valid

        Returns:
            List of voice dictionaries
        """
        # Check if cache is valid
        cache_valid = (
            self._cache_timestamp is not None and
            datetime.now() - self._cache_timestamp < timedelta(hours=self.cache_ttl_hours)
        )

        if not force_refresh and cache_valid and self._voice_cache:
            print(f"[+] Using cached voices ({len(self._voice_cache)} voices)")
            return list(self._voice_cache.values())

        # Fetch from Microsoft API
        voices = await self.fetch_voices_from_microsoft()

        if not voices:
            # Fallback to hardcoded voices if API fails
            print("[!] Microsoft API unavailable, using fallback voices")
            return list(FALLBACK_VOICES.values())

        # Update cache
        self._voice_cache = {voice['id']: voice for voice in voices}
        self._cache_timestamp = datetime.now()

        # Save to file
        self._save_cache_to_file()

        return voices

    def get_voice_by_id(self, voice_id: str) -> Optional[Dict]:
        """
        Get a specific voice by ID

        Args:
            voice_id: Voice identifier (e.g., "en-GB-SoniaNeural")

        Returns:
            Voice dictionary or None if not found
        """
        # Check in-memory cache
        if voice_id in self._voice_cache:
            return self._voice_cache[voice_id]

        # Check fallback voices
        if voice_id in FALLBACK_VOICES:
            return FALLBACK_VOICES[voice_id]

        return None

    def find_similar_voice(self, voice_id: str) -> Optional[Dict]:
        """
        Find a similar voice if the requested one is deprecated

        Args:
            voice_id: Original voice identifier

        Returns:
            Similar voice dictionary or None
        """
        # Extract locale and gender from voice_id
        # Format: "en-GB-SoniaNeural"
        parts = voice_id.split('-')

        if len(parts) < 2:
            return None

        target_locale = f"{parts[0]}-{parts[1]}"

        # Try to find a voice with same locale
        for voice in self._voice_cache.values():
            if voice['locale'] == target_locale:
                print(f"[+] Found similar voice: {voice['id']} for deprecated {voice_id}")
                return voice

        # Fallback to any voice from same language
        language = parts[0]
        for voice in self._voice_cache.values():
            if voice['locale'].startswith(language):
                print(f"[+] Found fallback voice: {voice['id']} for deprecated {voice_id}")
                return voice

        # Last resort: return first available voice
        if self._voice_cache:
            fallback = list(self._voice_cache.values())[0]
            print(f"[!] Using first available voice: {fallback['id']} for deprecated {voice_id}")
            return fallback

        return None

    def get_voice_name(self, voice_id: str) -> str:
        """
        Get display name for a voice ID

        Args:
            voice_id: Voice identifier

        Returns:
            Display name or 'AI Voice' if not found
        """
        voice = self.get_voice_by_id(voice_id)
        if voice:
            return voice['name']

        # Try to find similar voice
        similar = self.find_similar_voice(voice_id)
        if similar:
            return f"{similar['name']} (fallback)"

        return 'AI Voice'


# Global instance (will be initialized by the Flask app)
voice_manager: Optional[VoiceManager] = None


def get_voice_manager() -> VoiceManager:
    """Get the global VoiceManager instance"""
    global voice_manager

    if voice_manager is None:
        # Read configuration from environment variables.
        # Default TTL is 1 week — voices rarely change and regenerating 188
        # voices on every 24-hour expiry adds unnecessary latency on startup.
        # Default locale list covers all 27 languages we ship voices for so
        # that a cache-miss re-fetch on Render still returns the full set
        # without needing VOICE_FILTER_LOCALES set in the environment.
        _ALL_SUPPORTED = 'en,es,fr,de,it,pt,nl,pl,ru,zh,ja,ko,ar,hi,tr,cy,ga,uk,el,he,sv,da,nb,fi,cs,hu,ro'
        cache_ttl_hours = int(os.getenv('VOICE_CACHE_TTL_HOURS', '168'))
        filter_neural_only = os.getenv('VOICE_FILTER_NEURAL_ONLY', 'true').lower() == 'true'
        filter_locales_str = os.getenv('VOICE_FILTER_LOCALES', _ALL_SUPPORTED)
        filter_locales = [loc.strip() for loc in filter_locales_str.split(',')]

        # Initialize with environment configuration
        voice_manager = VoiceManager(
            cache_file="voice_cache.json",
            cache_ttl_hours=cache_ttl_hours,
            filter_neural_only=filter_neural_only,
            filter_locales=filter_locales
        )

    return voice_manager
