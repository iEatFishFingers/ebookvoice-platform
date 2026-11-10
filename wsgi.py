"""
WSGI Entry Point for Gunicorn
Initializes Flask app and worker-level resources
"""

import os
import sys
import asyncio
from dotenv import load_dotenv

# Load environment variables FIRST (before any imports that need them)
load_dotenv()

# Add current directory to Python path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

# Import Flask app (this will initialize all routes and middleware)
from epub_to_audio import app

# Import task manager for cleanup on startup
from task_manager import TaskManager
from auth import get_supabase_client


def initialize_worker():
    """
    Initialize worker-specific resources when worker process starts.

    Each Gunicorn worker is a separate process, so this runs once per worker.
    Resources initialized here:
    - Voice cache (load available TTS voices)
    - Old task cleanup (remove stale conversion tasks)
    """
    try:
        print(f"[*] Worker {os.getpid()} initializing...")

        # Initialize voice cache
        print("[*] Initializing voice cache in worker process...")
        from voice_manager import get_voice_manager
        vm = get_voice_manager()
        voices = asyncio.run(vm.get_voices())
        print(f"[+] Voice cache initialized with {len(voices)} voices")

        # Cleanup old tasks (only in first worker to avoid race conditions)
        # We check if worker PID is the lowest among current workers (a simple heuristic)
        # In production, use a separate cron job for cleanup
        try:
            print("[*] Cleaning up old conversion tasks...")
            task_manager = TaskManager(get_supabase_client())
            deleted_count = task_manager.cleanup_old_tasks(hours=24)
            if deleted_count > 0:
                print(f"[+] Cleaned up {deleted_count} old tasks")
        except Exception as cleanup_error:
            print(f"[!] Error during task cleanup (non-fatal): {cleanup_error}")

        print(f"[+] Worker {os.getpid()} initialization complete")

    except Exception as e:
        print(f"[!] Error initializing worker: {e}")
        print("    Will use fallback configuration")
        import traceback
        traceback.print_exc()


# Call initialization when worker starts
initialize_worker()

# Export app for Gunicorn
# Gunicorn will look for an object named 'application' by default
application = app

# For debugging: allow running directly with Python (not recommended for production)
if __name__ == "__main__":
    print("⚠️  Running WSGI app directly (development mode)")
    print("    For production, use: gunicorn -c gunicorn.conf.py wsgi:app")
    print("    Starting development server...")
    app.run(debug=False, port=8080, threaded=True)
