-- Migration 007: conversion_tasks.image_upload_id
-- Run via: Supabase SQL Editor
-- Safe to re-run (IF NOT EXISTS guard).
--
-- Stores the token returned by /extract-chapters that references the
-- background image upload job. The conversion worker reads this to know
-- which _image_upload_cache entry to wait on before saving chapter rows.
-- Nullable: NULL means the book had no inline images (text-only EPUB).

ALTER TABLE conversion_tasks
  ADD COLUMN IF NOT EXISTS image_upload_id TEXT;
