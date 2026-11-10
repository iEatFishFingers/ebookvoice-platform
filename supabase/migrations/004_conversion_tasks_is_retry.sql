-- Migration 004: conversion_tasks.is_retry
-- Run via: Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS).
--
-- Context: the May 2026 paywall redesign introduced "retry doesn't count"
-- (different voice / re-conversion of the same source EPUB this calendar
-- month does not increment the monthly conversion counter).  The gate logic
-- in _check_conversion_gate (epub_to_audio.py) decides this at enqueue time
-- and stashes the boolean on the task row so the worker can read it back
-- when the conversion completes and skip the counter increment if true.
--
-- Without this column every /convert-chapters call fails with PGRST204
-- ("Could not find the 'is_retry' column of 'conversion_tasks' in the
-- schema cache"), task_manager.create_task() swallows the error, and the
-- frontend ends up polling /status/<task_id> for a task that was never
-- persisted (404).
--
-- Nullable so older backend code that doesn't set this column keeps
-- inserting without error; a NULL is read as False by the worker.

ALTER TABLE conversion_tasks
  ADD COLUMN IF NOT EXISTS is_retry BOOLEAN DEFAULT FALSE;
