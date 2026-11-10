FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Python block-buffers stdout when it isn't a tty, so every print() sat in a
# buffer until it filled or the worker died: Render log lines carried the
# flush time, not the event time (off by up to ~90 min on 2026-09-12), and a
# worker killed by a restart lost whatever was buffered. Line-buffer instead.
ENV PYTHONUNBUFFERED=1

# Install system dependencies for edge-tts and other packages
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (for better caching)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port (Render will set PORT env var)
EXPOSE 8080

# Start command
CMD ["gunicorn", "-c", "gunicorn.conf.py", "wsgi:app"]
