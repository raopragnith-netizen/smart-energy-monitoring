"""
bill_processor.py — PaddleOCR-based electricity bill data extraction module.

Supports Indian electricity bills from:
  APSPDCL, APEPDCL, TSSPDCL, TSNPDCL, BESCOM, TANGEDCO, MSEDCL,
  BSES, TATA POWER, UPPCL, WBSEDCL, KSEB, and other standard formats.

Image preprocessing pipeline:
  1. Automatic image resizing
  2. Grayscale conversion
  3. Noise reduction (bilateral filter)
  4. Contrast enhancement (CLAHE)
  5. Adaptive thresholding
  6. Skew and rotation correction
  7. Image quality validation

Extracts: consumer number, service number, billing month, billing date,
due date, total units consumed, bill amount, meter readings, and
electricity board.

Per-field confidence scoring with validation.
Converts extracted data into structured format for ML processing.
"""

import re
import os
import io
import json
import random
import logging
import tempfile
import numpy as np
from datetime import datetime, timedelta
from dataclasses import dataclass, asdict
from typing import Any, Optional
from PIL import Image, ImageEnhance, ImageFilter

# Optional OpenCV import — used for advanced preprocessing
try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False
    print("[bill_processor] WARNING: OpenCV (cv2) not installed. "
          "Advanced preprocessing will be skipped.")

# Import validation module
try:
    from ocr_validator import (
        validate_bill_data,
        compute_confidence_penalty,
        cross_validate_readings,
    )
    _HAS_VALIDATOR = True
except ImportError:
    _HAS_VALIDATOR = False
    print("[bill_processor] WARNING: ocr_validator not found. Validation disabled.")


# ---------------------------------------------------------------------------
# Structured Logging
# ---------------------------------------------------------------------------

ocr_logger = logging.getLogger('ocr_pipeline')
ocr_logger.setLevel(logging.DEBUG)

# Console handler
_console_handler = logging.StreamHandler()
_console_handler.setLevel(logging.INFO)
_console_handler.setFormatter(logging.Formatter(
    '%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
))
ocr_logger.addHandler(_console_handler)

# File handler (create logs dir if needed)
_log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')
os.makedirs(_log_dir, exist_ok=True)
try:
    _file_handler = logging.FileHandler(
        os.path.join(_log_dir, 'ocr_pipeline.log'),
        encoding='utf-8',
    )
    _file_handler.setLevel(logging.DEBUG)
    _file_handler.setFormatter(logging.Formatter(
        '%(asctime)s | %(levelname)s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    ))
    ocr_logger.addHandler(_file_handler)
except Exception:
    pass  # Non-critical if log file can't be opened


# ---------------------------------------------------------------------------
# Field Result Dataclass
# ---------------------------------------------------------------------------

class FieldResult:
    """Holds an extracted field value with confidence metadata."""
    def __init__(self, value, confidence, source, raw_match=''):
        self.value = value
        self.confidence = confidence
        self.source = source
        self.raw_match = raw_match

    def to_dict(self):
        return {
            'value': self.value,
            'confidence': round(self.confidence, 1),
            'source': self.source,
        }


# ---------------------------------------------------------------------------
# Lazy-load PaddleOCR reader
# ---------------------------------------------------------------------------
_paddleocr_reader = None


def _get_paddleocr_reader():
    """Initialize PaddleOCR reader (lazy, singleton)."""
    global _paddleocr_reader
    if _paddleocr_reader is None:
        ocr_logger.info("Initializing PaddleOCR reader...")
        from paddleocr import PaddleOCR
        _paddleocr_reader = PaddleOCR(
            use_textline_orientation=True,    # Automatic text angle classification
            lang='en',
            device='cpu',
            text_det_thresh=0.3,     # Lower threshold for better detection on bills
            text_det_box_thresh=0.5,
            text_recognition_batch_size=16,
            enable_mkldnn=False,
        )
        ocr_logger.info("PaddleOCR reader initialized successfully.")
    return _paddleocr_reader


# ---------------------------------------------------------------------------
# Image Quality Validation
# ---------------------------------------------------------------------------

def validate_image_quality(image_path):
    """Validate image quality before OCR processing.

    Checks:
      - File exists and is readable
      - Minimum resolution (400×400)
      - Image isn't entirely blank/black
      - Reasonable file size

    Returns:
        dict: {score: 0-100, issues: [str], valid: bool}
    """
    issues = []
    score = 100

    # Check file exists
    if not os.path.exists(image_path):
        return {'score': 0, 'issues': ['File not found'], 'valid': False}

    try:
        img = Image.open(image_path)
        w, h = img.size
    except Exception as e:
        return {'score': 0, 'issues': [f'Cannot open image: {e}'], 'valid': False}

    # Check resolution
    if w < 200 or h < 200:
        issues.append(f'Very low resolution ({w}×{h})')
        score -= 40
    elif w < 400 or h < 400:
        issues.append(f'Low resolution ({w}×{h})')
        score -= 20
    elif w < 800 or h < 800:
        issues.append(f'Below recommended resolution ({w}×{h})')
        score -= 10

    # Check if image is mostly blank/black
    try:
        gray = img.convert('L')
        pixels = np.array(gray)
        mean_val = float(np.mean(pixels))
        std_val = float(np.std(pixels))

        if std_val < 10:
            issues.append('Image appears to be blank or uniform')
            score -= 40
        elif std_val < 20:
            issues.append('Image has very low contrast')
            score -= 20

        if mean_val < 20:
            issues.append('Image is very dark')
            score -= 20
        elif mean_val > 240:
            issues.append('Image is very bright/washed out')
            score -= 15
    except Exception:
        pass

    # Check file size
    file_size = os.path.getsize(image_path)
    if file_size < 5000:  # < 5KB
        issues.append('File is very small, may be low quality')
        score -= 15
    elif file_size > 20 * 1024 * 1024:  # > 20MB
        issues.append('File is very large, may slow processing')
        score -= 5

    score = max(0, min(100, score))

    return {
        'score': score,
        'issues': issues,
        'valid': score >= 20,
        'resolution': f'{w}×{h}',
    }


# ---------------------------------------------------------------------------
# Image Preprocessing Pipeline
# ---------------------------------------------------------------------------

def preprocess_for_ocr(image_path):
    """Consolidated preprocessing pipeline for OCR.

    Generates multiple preprocessed variants and returns paths for OCR.
    PaddleOCR works best with different types of preprocessing depending
    on the source image quality.

    Pipeline:
      1. Deskew (rotation correction)
      2. Variant A: Original (deskewed only)
      3. Variant B: Enhanced grayscale (CLAHE + bilateral filter, no binarization)
      4. Variant C: Adaptive threshold (for noisy/low-contrast images)

    Returns:
        list of (path, label) tuples. Caller must clean up temp files.
    """
    # Step 0: Deskew
    deskewed_path = deskew_image(image_path)
    deskew_is_temp = (deskewed_path != image_path)
    source = deskewed_path

    variants = []

    # Variant A: Original (or deskewed)
    variants.append((source, 'original'))

    # Variant B: Enhanced grayscale (PIL-based, always available)
    try:
        pil_path = _preprocess_pil_enhanced(source)
        variants.append((pil_path, 'pil-enhanced'))
    except Exception as e:
        ocr_logger.debug(f"PIL preprocessing failed: {e}")

    # Variant C: OpenCV enhanced (CLAHE + bilateral, no binarization)
    if _HAS_CV2:
        try:
            cv_path = _preprocess_opencv_enhanced(source)
            if cv_path:
                variants.append((cv_path, 'opencv-enhanced'))
        except Exception as e:
            ocr_logger.debug(f"OpenCV preprocessing failed: {e}")

        # Variant D: Adaptive threshold (for tough images)
        try:
            thresh_path = _preprocess_opencv_threshold(source)
            if thresh_path:
                variants.append((thresh_path, 'opencv-threshold'))
        except Exception as e:
            ocr_logger.debug(f"OpenCV threshold failed: {e}")

    ocr_logger.debug(f"Preprocessing complete: {len(variants)} variants generated")
    return variants


def _preprocess_pil_enhanced(image_path):
    """Enhanced PIL-based preprocessing for OCR.

    Steps:
      1. Resize small images (min 1500px width)
      2. Grayscale
      3. Contrast enhancement (1.5×)
      4. Sharpness enhancement (1.5×)

    No binarization — preserves colored text for deep-learning OCR.
    """
    img = Image.open(image_path).convert('RGB')

    # Resize small images
    w, h = img.size
    if w < 1500 or h < 1500:
        scale = max(1500 / w, 1500 / h, 1.0)
        new_w, new_h = int(w * scale), int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)

    # Grayscale
    gray = img.convert('L')

    # Contrast enhancement
    enhancer = ImageEnhance.Contrast(gray)
    gray = enhancer.enhance(1.5)

    # Sharpness enhancement
    enhancer = ImageEnhance.Sharpness(gray)
    gray = enhancer.enhance(1.5)

    # Save preprocessed image
    preprocessed_path = image_path + '_pil_enhanced.png'
    gray.save(preprocessed_path, 'PNG')
    return preprocessed_path


def _preprocess_opencv_enhanced(image_path):
    """OpenCV preprocessing without hard binarization.

    CLAHE + bilateral filter — keeps gray levels for deep-learning OCR.
    """
    if not _HAS_CV2:
        return None

    img = cv2.imread(image_path)
    if img is None:
        return None

    # Resize small images
    h, w = img.shape[:2]
    if w < 1500 or h < 1500:
        scale = max(1500 / w, 1500 / h, 1.0)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # CLAHE — adaptive contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Bilateral filter — edge-preserving noise removal
    gray = cv2.bilateralFilter(gray, 9, 75, 75)

    fd, out_path = tempfile.mkstemp(suffix='_opencv_enhanced.png')
    os.close(fd)
    cv2.imwrite(out_path, gray)
    return out_path


def _preprocess_opencv_threshold(image_path):
    """OpenCV preprocessing with adaptive thresholding.

    For noisy/low-contrast scanned documents where binarization helps.
    """
    if not _HAS_CV2:
        return None

    img = cv2.imread(image_path)
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # CLAHE
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Bilateral filter
    gray = cv2.bilateralFilter(gray, 11, 75, 75)

    # Adaptive Gaussian thresholding
    thresh = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=31,
        C=10,
    )

    fd, out_path = tempfile.mkstemp(suffix='_opencv_thresh.png')
    os.close(fd)
    cv2.imwrite(out_path, thresh)
    return out_path


def deskew_image(image_path):
    """Correct rotation/skew of a scanned bill using Hough line detection.

    Steps:
      1. Grayscale → Canny edge detection
      2. Probabilistic Hough transform to find line segments
      3. Compute median angle of detected lines
      4. Rotate image to correct if skew > 0.5°

    Returns:
        str: Path to the deskewed image (may be same as input if no
             correction was needed).
    """
    if not _HAS_CV2:
        return image_path

    try:
        img = cv2.imread(image_path)
        if img is None:
            return image_path

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)

        lines = cv2.HoughLinesP(
            edges, 1, np.pi / 180,
            threshold=100, minLineLength=100, maxLineGap=10,
        )

        if lines is None or len(lines) == 0:
            return image_path

        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            # Only consider near-horizontal lines (within ±30°)
            if abs(angle) < 30:
                angles.append(angle)

        if not angles:
            return image_path

        median_angle = float(np.median(angles))

        if abs(median_angle) < 0.5:
            # Skew is negligible
            return image_path

        ocr_logger.info(f"Deskew: rotating by {median_angle:.2f}°")

        (h, w) = img.shape[:2]
        center = (w // 2, h // 2)
        rotation_matrix = cv2.getRotationMatrix2D(center, median_angle, 1.0)
        rotated = cv2.warpAffine(
            img, rotation_matrix, (w, h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )

        fd, out_path = tempfile.mkstemp(suffix='_deskewed.png')
        os.close(fd)
        cv2.imwrite(out_path, rotated)
        return out_path
    except Exception as exc:
        ocr_logger.warning(f"Deskew failed: {exc}")
        return image_path


# ---------------------------------------------------------------------------
# PaddleOCR Text Extraction
# ---------------------------------------------------------------------------

def _parse_paddle_result(result):
    """Convert PaddleOCR output into sorted text lines with confidence data.

    PaddleOCR returns: [[box, (text, confidence)], ...]
    Where box is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]

    Returns:
        tuple: (full_text, detection_data)
        detection_data is a list of {text, confidence, bbox_top_y}
    """
    if not result or not result[0]:
        return '', []

    detections = []
    for item in result[0]:
        if item is None or len(item) < 2:
            continue
        box = item[0]
        text_conf = item[1]
        if text_conf is None or len(text_conf) < 2:
            continue

        text = str(text_conf[0]).strip()
        conf = float(text_conf[1])
        # Top-left Y coordinate for sorting
        top_y = float(box[0][1])
        top_x = float(box[0][0])

        if text:
            detections.append({
                'text': text,
                'confidence': conf,
                'top_y': top_y,
                'top_x': top_x,
            })

    if not detections:
        return '', []

    # Sort by vertical position, then horizontal
    detections.sort(key=lambda d: (d['top_y'], d['top_x']))

    # Group into lines: items within 15px vertical distance = same line
    lines = []
    current_line = []
    current_y = None

    for det in detections:
        if current_y is None or abs(det['top_y'] - current_y) < 15:
            current_line.append(det)
            current_y = det['top_y'] if current_y is None else current_y
        else:
            # Sort current line left-to-right
            current_line.sort(key=lambda d: d['top_x'])
            lines.append(current_line)
            current_line = [det]
            current_y = det['top_y']

    if current_line:
        current_line.sort(key=lambda d: d['top_x'])
        lines.append(current_line)

    # Build text and flat detection list
    text_lines = []
    for line in lines:
        line_text = ' '.join(d['text'] for d in line)
        text_lines.append(line_text)

    full_text = '\n'.join(text_lines)
    return full_text, detections


def extract_text_from_image(image_path):
    """Extract text from image using PaddleOCR with multi-pass preprocessing.

    Runs OCR on multiple preprocessed variants and picks the best result
    (longest text output).

    Returns:
        tuple: (extracted_text, detection_data)
    """
    import time
    start_time = time.time()

    reader = _get_paddleocr_reader()

    # Quality check
    quality = validate_image_quality(image_path)
    ocr_logger.info(f"Image quality: {quality['score']}/100, issues: {quality['issues']}")

    if not quality['valid']:
        ocr_logger.error(f"Image quality too low: {quality['issues']}")
        return '', []

    # Get preprocessed variants
    variants = preprocess_for_ocr(image_path)
    temp_files = []

    candidates = []
    for path, label in variants:
        if path != image_path:
            temp_files.append(path)
        try:
            try:
                result = reader.ocr(path, cls=True)
            except TypeError:
                result = reader.ocr(path)
            text, detections = _parse_paddle_result(result)
            avg_conf = (
                sum(d['confidence'] for d in detections) / len(detections)
                if detections else 0
            )
            candidates.append((label, text, detections, len(text), avg_conf))
            
            # Optimization: if confidence is high and we got decent text, stop running more variants
            if avg_conf >= 0.85 and len(text) >= 150:
                ocr_logger.info(f"Early exit: variant '{label}' has high confidence ({avg_conf:.4f}) and text length ({len(text)}). Skipping remaining variants.")
                break
        except Exception as e:
            ocr_logger.debug(f"OCR on {label} variant failed: {e}")

    # Cleanup temp files
    for tmp in temp_files:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    if not candidates:
        ocr_logger.error("All OCR attempts failed")
        return '', []

    # Pick best result: longest text, weighted by confidence
    best = max(candidates, key=lambda c: c[3] * (1 + c[4]))
    elapsed = time.time() - start_time

    ocr_logger.info(
        f"Best OCR source: {best[0]} ({best[3]} chars, avg_conf={best[4]:.2f}) "
        f"[{elapsed:.1f}s] vs "
        + ", ".join(f"{c[0]}={c[3]}" for c in candidates)
    )

    return best[1], best[2]


def extract_text_from_pdf(pdf_path):
    """Extract text from a PDF file.

    First attempts direct text extraction via PyMuPDF.
    Falls back to OCR on rendered page images if text is sparse.

    Returns:
        tuple: (extracted_text, detection_data)
    """
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    all_text = []
    all_detections = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        if text and len(text.strip()) > 50:
            all_text.append(text)
        else:
            # Render page as high-DPI image and OCR
            pix = page.get_pixmap(dpi=300)
            img_data = pix.tobytes("png")
            temp_path = pdf_path + f'_page_{page_num}.png'
            with open(temp_path, 'wb') as f:
                f.write(img_data)
            ocr_text, ocr_dets = extract_text_from_image(temp_path)
            all_text.append(ocr_text)
            all_detections.extend(ocr_dets)
            try:
                os.remove(temp_path)
            except OSError:
                pass

    doc.close()
    return '\n'.join(all_text), all_detections


# ---------------------------------------------------------------------------
# Line-Aware Extraction Helper
# ---------------------------------------------------------------------------

def _extract_line_value(lines, label_pattern, value_pattern=r'([\d,\.]+)'):
    """Search lines for a label pattern and extract a nearby numeric value."""
    for i, line in enumerate(lines):
        if re.search(label_pattern, line, re.IGNORECASE):
            # Try to find value on the same line, AFTER the label
            match = re.search(label_pattern + r'[^\d]*' + value_pattern, line, re.IGNORECASE)
            if match:
                return match.group(match.lastindex)
            # Try just finding any number on this line
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                return nums[-1]
            # Check next line for a standalone number
            if i + 1 < len(lines):
                nums = re.findall(r'[\d,]+\.?\d*', lines[i + 1])
                if nums:
                    return nums[0]
    return None


# ---------------------------------------------------------------------------
# OCR Number/String Cleaning
# ---------------------------------------------------------------------------

def clean_ocr_number(num_str):
    """Clean OCR-recognized number string, fixing common misreads."""
    if not num_str:
        return None
    cleaned = num_str.replace('I', '1').replace('l', '1').replace('|', '1')
    cleaned = cleaned.replace('O', '0').replace('o', '0')
    cleaned = cleaned.replace(',', '')
    try:
        return float(cleaned)
    except ValueError:
        match = re.search(r'([0-9\.]+)', cleaned)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                return None
    return None


def clean_consumer_number(num_str):
    """Clean OCR-recognized consumer number string."""
    if not num_str:
        return None
    cleaned = num_str.replace('I', '1').replace('l', '1').replace('|', '1')
    cleaned = cleaned.replace('O', '0').replace('o', '0')
    return cleaned.strip()


# ---------------------------------------------------------------------------
# Line-Aware Extraction Functions (Primary)
# ---------------------------------------------------------------------------

def _extract_consumer_line(lines, detections=None):
    """Find consumer/service number from the line containing the label."""
    label_pat = (
        r'(?:consumer\s*(?:id|no|number|num|code)|'
        r'service\s*(?:no|number|num|id|conn)|'
        r'sc\s*(?:no|number|num|id)|'
        r'rr\s*(?:no|number|num)|'
        r'k\s*(?:no|number|num)|'
        r'account\s*(?:no|number|num|id)|'
        r'bp\s*no|ca\s*no|usc\s*no|consumer\s*number)'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            parts = re.split(r'[:=]', line, maxsplit=1)
            if len(parts) > 1:
                candidate = parts[1].strip()
                candidate = re.sub(
                    r'^(?:no|number|num|id|#)\.?\s*', '', candidate,
                    flags=re.IGNORECASE,
                )
                match = re.search(r'([a-zA-Z0-9\-\/]{4,20})', candidate)
                if match:
                    return clean_consumer_number(match.group(1)), avg_conf

            label_match = re.search(label_pat, line, re.IGNORECASE)
            after_label = line[label_match.end():]
            nums = re.findall(r'([a-zA-Z0-9\-\/]{4,20})', after_label)
            if nums:
                for n in nums:
                    cleaned = clean_consumer_number(n)
                    if (cleaned and len(cleaned) >= 4 and
                            cleaned.lower() not in ['no', 'number', 'num', 'code', 'id']):
                        return cleaned, avg_conf
    return None, 0


def _extract_service_number_line(lines, detections=None):
    """Find service/connection number (distinct from consumer number)."""
    label_pat = (
        r'(?:service\s*(?:no|number|num|id|connection)|'
        r'connection\s*(?:no|number|num|id)|'
        r'supply\s*(?:no|number|num))'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            parts = re.split(r'[:=]', line, maxsplit=1)
            if len(parts) > 1:
                candidate = parts[1].strip()
                match = re.search(r'([a-zA-Z0-9\-\/]{3,20})', candidate)
                if match:
                    return clean_consumer_number(match.group(1)), avg_conf
    return None, 0


def _extract_billing_month_line(lines, detections=None):
    """Find billing month from the line containing BILL MONTH or similar."""
    label_pat = (
        r'(?:bill\s*month|billing?\s*(?:month|period)|'
        r'month\s*of|bill\s*date|date\s*of\s*bill|bill\s*dt)'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            # Check for Month Name + Year e.g. "March 2026" or "MAR-2026"
            m = re.search(
                r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
                r'[a-z]*[\s\-]*\d{4})', line, re.IGNORECASE,
            )
            if m:
                return m.group(1).strip(), avg_conf
            # Standard dates e.g. "12/05/2026" or "12-05-2026"
            m = re.search(r'(\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4})', line)
            if m:
                date_str = m.group(1)
                date_str = date_str.replace('I', '1').replace('l', '1')
                date_str = date_str.replace('O', '0').replace('o', '0')
                for fmt in ['%d/%m/%Y', '%d-%m-%Y', '%m/%d/%Y', '%m-%d-%Y',
                            '%d/%m/%y', '%d-%m-%y']:
                    try:
                        dt = datetime.strptime(date_str, fmt)
                        return dt.strftime('%B %Y'), avg_conf
                    except ValueError:
                        continue
            # MM/YYYY or MM-YYYY
            m = re.search(r'(\b\d{1,2}[\-/]\d{4}\b)', line)
            if m:
                month_str = m.group(1)
                month_str = month_str.replace('I', '1').replace('l', '1')
                month_str = month_str.replace('O', '0').replace('o', '0')
                parts = re.split(r'[\-/]', month_str)
                if len(parts) == 2:
                    try:
                        mon = int(parts[0])
                        yr = int(parts[1])
                        if 1 <= mon <= 12:
                            dt = datetime(yr, mon, 1)
                            return dt.strftime('%B %Y'), avg_conf
                    except ValueError:
                        pass
    return None, 0


def _extract_billing_date_line(lines, detections=None):
    """Find billing date from lines."""
    label_pat = (
        r'(?:bill\s*date|date\s*of\s*bill|bill\s*dt|'
        r'billing\s*date|invoice\s*date)'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            m = re.search(r'(\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4})', line)
            if m:
                return m.group(1).strip(), avg_conf
            m = re.search(
                r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
                r'[a-z]*[\s\-]*\d{1,2}[\s,\-]*\d{4})', line, re.IGNORECASE,
            )
            if m:
                return m.group(1).strip(), avg_conf
    return None, 0


def _extract_due_date_line(lines, detections=None):
    """Find due date from lines."""
    label_pat = (
        r'(?:due\s*date|last\s*date|payment\s*(?:due|before|by)|'
        r'pay\s*(?:before|by)|due\s*on)'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            m = re.search(r'(\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4})', line)
            if m:
                return m.group(1).strip(), avg_conf
            m = re.search(
                r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
                r'[a-z]*[\s\-]*\d{1,2}[\s,\-]*\d{4})', line, re.IGNORECASE,
            )
            if m:
                return m.group(1).strip(), avg_conf
    return None, 0


def _extract_units_line(lines, detections=None):
    """Find total units consumed from lines containing unit-related labels."""
    avg_conf = 0

    # Priority 1: Table-based extraction
    for i, line in enumerate(lines):
        if (re.search(r'current\s*reading', line, re.IGNORECASE) and
                re.search(r'(?:units|consumed|kwh)', line, re.IGNORECASE)):
            for j in range(i + 1, min(i + 6, len(lines))):
                data_line = lines[j]
                nums = re.findall(r'[\d,]+', data_line)
                if len(nums) >= 3:
                    vals = [clean_ocr_number(n) for n in nums]
                    vals = [v for v in vals if v is not None]
                    large_vals = sorted([v for v in vals if v > 1000], reverse=True)
                    if len(large_vals) >= 2:
                        diff = large_vals[0] - large_vals[1]
                        if 1 <= diff <= 50000:
                            avg_conf = _get_avg_conf_for_pattern(
                                lines, r'(?:units|consumed|kwh)', detections,
                            )
                            return diff, avg_conf
                    small_vals = [v for v in vals if 1 <= v <= 5000 and
                                  v not in large_vals]
                    if small_vals:
                        from collections import Counter
                        counts = Counter(small_vals)
                        most_common = counts.most_common(1)[0]
                        if most_common[1] >= 2 and 1 <= most_common[0] <= 50000:
                            avg_conf = _get_avg_conf_for_pattern(
                                lines, r'(?:units|consumed|kwh)', detections,
                            )
                            return most_common[0], avg_conf

    # Priority 2: Label-based units
    label_pat = (
        r'(?:consumed\s*units|units\s*consumed|total\s*units|billed\s*units|'
        r'units\s*billed|consumption|energy\s*units|units\s*charged)'
    )
    avg_conf = _get_avg_conf_for_pattern(lines, label_pat, detections)

    for line in lines:
        if re.search(label_pat, line, re.IGNORECASE):
            if re.search(r'reading', line, re.IGNORECASE):
                continue
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and 0 < val < 100000:
                    return val, avg_conf

    # Priority 3: "N units" or "N kwh" pattern
    for line in lines:
        m = re.search(r'(\d+)\s*(?:units|kwh)\b', line, re.IGNORECASE)
        if m:
            val = clean_ocr_number(m.group(1))
            if val and 10 < val < 100000:
                return val, max(avg_conf, 60)

    # Priority 4: Compute from readings
    curr, _ = _extract_reading_line(lines, 'current', detections)
    prev, _ = _extract_reading_line(lines, 'previous', detections)
    if curr and prev and curr > prev:
        diff = curr - prev
        if 1 <= diff <= 50000:
            return diff, max(avg_conf, 70)  # Computed = medium confidence

    return None, 0


def _extract_amount_line(lines, detections=None):
    """Find bill amount from lines containing amount-related labels."""
    avg_conf = 0

    # Priority 1: "Total Amount Payable"
    for line in lines:
        if re.search(r'total\s*amount\s*payable|amount\s*payable|net\s*payable',
                      line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.\d{2}', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 0:
                    avg_conf = _get_avg_conf_for_pattern(
                        lines, r'amount\s*payable', detections,
                    )
                    return val, avg_conf

    # Priority 2: "Total Amount" / "Net Amount" / "Grand Total"
    for line in lines:
        if re.search(r'total\s*amount|net\s*amount|grand\s*total|due\s*amount',
                      line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 10:
                    avg_conf = _get_avg_conf_for_pattern(
                        lines, r'total\s*amount|net\s*amount', detections,
                    )
                    return val, avg_conf

    # Priority 3: "Bill Amount"
    for line in lines:
        if re.search(r'(?:current\s*)?bill\s*amount|amount\s*due|total\s*charges',
                      line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+\.?\d*', line)
            if nums:
                val = clean_ocr_number(nums[-1])
                if val and val > 10:
                    avg_conf = _get_avg_conf_for_pattern(
                        lines, r'bill\s*amount|amount\s*due', detections,
                    )
                    return val, avg_conf

    return None, 0


def _extract_reading_line(lines, reading_type='current', detections=None):
    """Find meter reading from lines containing reading labels."""
    if reading_type == 'current':
        pattern = r'(?:present|current|curr\.?)\s*(?:reading|rdg|meter)'
    else:
        pattern = r'(?:previous|prev\.?|last|opening|initial)\s*(?:reading|rdg|meter)'

    avg_conf = _get_avg_conf_for_pattern(lines, pattern, detections)

    for i, line in enumerate(lines):
        if re.search(pattern, line, re.IGNORECASE):
            nums = re.findall(r'[\d,]+', line)
            vals = [clean_ocr_number(n) for n in nums]
            vals = [v for v in vals if v is not None and v > 100]
            if vals:
                has_both = (
                    re.search(r'current\s*reading', line, re.IGNORECASE) and
                    re.search(r'previous\s*reading', line, re.IGNORECASE)
                )
                if has_both:
                    for j in range(i + 1, min(i + 4, len(lines))):
                        data_nums = re.findall(r'[\d,]+', lines[j])
                        data_vals = [clean_ocr_number(n) for n in data_nums]
                        data_vals = [v for v in data_vals if v is not None and v > 100]
                        if len(data_vals) >= 2:
                            sorted_vals = sorted(data_vals, reverse=True)
                            if reading_type == 'current':
                                return sorted_vals[0], avg_conf
                            else:
                                return sorted_vals[1], avg_conf
                    continue
                return (max(vals) if reading_type == 'current' else min(vals)), avg_conf

            if i + 1 < len(lines):
                next_nums = re.findall(r'[\d,]+', lines[i + 1])
                next_vals = [clean_ocr_number(n) for n in next_nums]
                next_vals = [v for v in next_vals if v is not None and v > 100]
                if next_vals:
                    return max(next_vals), avg_conf
    return None, 0


def _get_avg_conf_for_pattern(lines, pattern, detections):
    """Get average OCR confidence for detections matching a pattern."""
    if not detections:
        return 75  # Default confidence when no detection data
    matching_confs = []
    for det in detections:
        if re.search(pattern, det['text'], re.IGNORECASE):
            matching_confs.append(det['confidence'] * 100)
    return sum(matching_confs) / len(matching_confs) if matching_confs else 75


# ---------------------------------------------------------------------------
# Full-Text Regex Fallback Extraction
# ---------------------------------------------------------------------------

def extract_consumer_number(text):
    """Extract consumer/service number from bill text (fallback)."""
    patterns = [
        r'(?:consumer|consume|service|account|sc)\s*(?:no|number|#|id|num)[.:;\s]+'
        r'([a-zA-Z0-9\-/]{4,20})',
        r'(?:con\.?\s*no|cno|scno)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:RR\s*Number|RR\s*No)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:K\s*No|K\.No)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:contract\s*(?:no|number))[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:customer\s*(?:id|no|number))[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
        r'(?:supply\s*no)[.:;\s]+([a-zA-Z0-9\-/]{4,20})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return clean_consumer_number(match.group(1))
    return None


def extract_billing_month(text):
    """Extract billing month/period from bill text (fallback)."""
    patterns = [
        r'(?:billing?\s*(?:month|period)|month\s*of|for\s*(?:the\s*)?month)'
        r'[.:;\s]*([A-Za-z]+[\s\-]*[0-9IOol]{2,4})',
        r'(?:bill\s*date|date\s*of\s*bill|bill\s*dt)[.:;\s]*'
        r'([0-9IOol]{1,2}[\-/][0-9IOol]{1,2}[\-/][0-9IOol]{2,4})',
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'[a-z]*[\s\-,]*(?:20[0-9IOol]{2}))',
        r'([0-9IOol]{1,2}[\-/][0-9IOol]{4})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = match.group(0).strip() if match.lastindex == 0 else match.group(1).strip()
            val = val.replace('I', '1').replace('l', '1')
            val = val.replace('O', '0').replace('o', '0')
            return val
    return None


def extract_total_units(text):
    """Extract total units consumed from bill text (fallback)."""
    patterns = [
        r'(?:total\s*units?\s*(?:consumed|con\.?)|units?\s*consumed|'
        r'consumption\s*(?:units?)?)[.:;\s]*([0-9IOol\.\,]+)',
        r'(?:kwh\s*consumed|energy\s*consumed|energy\s*charges?\s*for)'
        r'[.:;\s]*([0-9IOol\.\,]+)',
        r'(?:present|current|curr\.?)\s*(?:reading|rdg)[^0-9IOol]*([0-9IOol]+)\s*[\-]\s*'
        r'(?:previous|prev)\s*(?:reading|rdg)[^0-9IOol]*([0-9IOol]+)',
        r'(?:consumption|units?\s*used)[.:;\s]*([0-9IOol\.\,]+)\s*(?:kwh|units?)?',
        r'(?:units?\s*charged|billable\s*units?)[.:;\s]*([0-9IOol\.\,]+)',
        r'([0-9IOol]+)\s*(?:units?\s*consumed|kwh\s*consumed|kwh)',
        r'(?:units|kwh)\s*[.:;\s]*([0-9IOol\.\,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            groups = match.groups()
            if len(groups) == 2:
                val1 = clean_ocr_number(groups[0])
                val2 = clean_ocr_number(groups[1])
                if val1 is not None and val2 is not None:
                    diff = val1 - val2
                    if 0 < diff < 100000:
                        return diff
            else:
                val = clean_ocr_number(groups[0])
                if val is not None and 0 < val < 100000:
                    return val
    return None


def extract_bill_amount(text):
    """Extract total bill amount from bill text (fallback)."""
    patterns = [
        r'(?:total\s*amount|net\s*amount|amount\s*payable|grand\s*total|'
        r'bill\s*amount)[.:;\s]*(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:Rs\.?\s*|₹\s*)([0-9IOol,\.]+)\s*(?:payable|due|total)',
        r'(?:current\s*bill\s*amount|this\s*month\s*amount)[.:;\s]*'
        r'(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:amount\s*due|amount\s*to\s*pay)[.:;\s]*'
        r'(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
        r'(?:payable\s*amount)[.:;\s]*(?:Rs\.?\s*|₹\s*)?([0-9IOol,\.]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None and val > 0:
                return val
    return None


def extract_previous_reading(text):
    """Extract previous meter reading (fallback)."""
    patterns = [
        r'(?:previous|prev\.?|last)\s*(?:reading|rdg\.?|meter)[.:;\s]*'
        r'([0-9IOol\.\,]+)',
        r'(?:opening\s*reading)[.:;\s]*([0-9IOol\.\,]+)',
        r'(?:initial\s*reading)[.:;\s]*([0-9IOol\.\,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None:
                return val
    return None


def extract_current_reading(text):
    """Extract current meter reading (fallback)."""
    patterns = [
        r'(?:present|current|curr\.?)\s*(?:reading|rdg\.?|meter)[.:;\s]*'
        r'([0-9IOol\.\,]+)',
        r'(?:closing\s*reading|final\s*reading)[.:;\s]*([0-9IOol\.\,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            val = clean_ocr_number(match.group(1))
            if val is not None:
                return val
    return None


# ---------------------------------------------------------------------------
# Electricity Board Detection
# ---------------------------------------------------------------------------

def detect_board(text):
    """Detect the electricity board from bill text."""
    text_upper = text.upper()

    board_patterns = {
        'TSSPDCL': [r'TSSPDCL', r'TELANGANA\s*SOUTH', r'TS\s*SOUTH',
                     r'TELANGANA\s*STATE\s*SOUTH'],
        'TSNPDCL': [r'TSNPDCL', r'TELANGANA\s*NORTH', r'TS\s*NORTH'],
        'APSPDCL': [r'APSPDCL', r'SOUTHERN\s*POWER', r'AP\s*SOUTH',
                     r'ANDHRA\s*PRADESH\s*SOUTHERN'],
        'APEPDCL': [r'APEPDCL', r'EASTERN\s*POWER', r'AP\s*EAST',
                     r'ANDHRA\s*PRADESH\s*EASTERN'],
        'BESCOM':  [r'BESCOM', r'BANGALORE\s*ELECTRICITY',
                     r'BENGALURU\s*ELECTRICITY'],
        'MESCOM':  [r'MESCOM', r'MANGALORE\s*ELECTRICITY'],
        'HESCOM':  [r'HESCOM', r'HUBLI\s*ELECTRICITY'],
        'CESC':    [r'CESC', r'CHAMUNDESHWARI'],
        'TANGEDCO': [r'TANGEDCO', r'TNEB',
                      r'TAMIL\s*NADU\s*ELECTRICITY'],
        'MSEDCL':  [r'MSEDCL', r'MAHARASHTRA\s*STATE\s*ELECTRICITY',
                     r'MAHADISCOM'],
        'BSES':    [r'BSES', r'BSES\s*RAJDHANI', r'BSES\s*YAMUNA'],
        'TATA POWER': [r'TATA\s*POWER'],
        'UPPCL':   [r'UPPCL', r'UTTAR\s*PRADESH\s*POWER'],
        'WBSEDCL': [r'WBSEDCL', r'WEST\s*BENGAL\s*STATE'],
        'KSEB':    [r'KSEB', r'KERALA\s*STATE\s*ELECTRICITY'],
        'DHBVN':   [r'DHBVN', r'DAKSHIN\s*HARYANA'],
        'UHBVN':   [r'UHBVN', r'UTTAR\s*HARYANA'],
        'JVVNL':   [r'JVVNL', r'JAIPUR\s*VIDYUT'],
        'PSPCL':   [r'PSPCL', r'PUNJAB\s*STATE\s*POWER'],
    }

    for board_name, patterns in board_patterns.items():
        for pattern in patterns:
            if re.search(pattern, text_upper):
                return board_name

    return 'Unknown'


# ---------------------------------------------------------------------------
# Main Extraction Entry Point
# ---------------------------------------------------------------------------

def extract_bill_data(file_path):
    """Extract structured bill data from an image or PDF.

    Uses PaddleOCR with multi-pass preprocessing and per-field confidence.

    Returns:
        dict: Extracted bill fields with per-field confidence scores,
              validation results, and overall confidence.

    Raises:
        ValueError: If file format is unsupported or OCR yields no text.
    """
    import time
    pipeline_start = time.time()

    ocr_logger.info(f"OCR started for file: {os.path.basename(file_path)}")

    ext = os.path.splitext(file_path)[1].lower()

    # Image quality check
    quality_result = {'score': 100, 'issues': [], 'valid': True}
    if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']:
        quality_result = validate_image_quality(file_path)
        ocr_logger.info(f"Image quality: {quality_result['score']}/100")

    if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']:
        raw_text, detections = extract_text_from_image(file_path)
    elif ext == '.pdf':
        raw_text, detections = extract_text_from_pdf(file_path)
    else:
        raise ValueError(f"Unsupported file format: {ext}. Accepted: JPG, PNG, PDF")

    if not raw_text or len(raw_text.strip()) < 10:
        raise ValueError(
            "Could not extract readable text from the bill. "
            "The image may be blurry or too low resolution."
        )

    ocr_logger.info(f"PaddleOCR extracted {len(raw_text)} chars, "
                     f"{len(detections)} text regions")

    # OCR Debug Logging
    raw_preview = raw_text[:500].encode('ascii', errors='replace').decode('ascii')
    ocr_logger.debug(f"Raw OCR text (first 500 chars):\n{raw_preview}")

    # Split into lines for line-aware extraction
    lines = [l.strip() for l in raw_text.split('\n') if l.strip()]

    # Detect the electricity board
    board = detect_board(raw_text)

    # --- Line-aware extraction (primary) with confidence ---
    consumer_number, consumer_conf = _extract_consumer_line(lines, detections)
    service_number, service_conf = _extract_service_number_line(lines, detections)
    billing_month, month_conf = _extract_billing_month_line(lines, detections)
    billing_date, bdate_conf = _extract_billing_date_line(lines, detections)
    due_date, ddate_conf = _extract_due_date_line(lines, detections)
    total_units, units_conf = _extract_units_line(lines, detections)
    bill_amount, amount_conf = _extract_amount_line(lines, detections)
    previous_reading, prev_conf = _extract_reading_line(lines, 'previous', detections)
    current_reading, curr_conf = _extract_reading_line(lines, 'current', detections)

    # --- Fallback: full-text regex (if line-aware missed) ---
    if not consumer_number:
        consumer_number = extract_consumer_number(raw_text)
        consumer_conf = 60 if consumer_number else 0  # Lower confidence for fallback
    if not billing_month:
        billing_month = extract_billing_month(raw_text)
        month_conf = 60 if billing_month else 0
    if not total_units:
        total_units = extract_total_units(raw_text)
        units_conf = 60 if total_units else 0
    if not bill_amount:
        bill_amount = extract_bill_amount(raw_text)
        amount_conf = 60 if bill_amount else 0
    if not previous_reading:
        previous_reading = extract_previous_reading(raw_text)
        prev_conf = 55 if previous_reading else 0
    if not current_reading:
        current_reading = extract_current_reading(raw_text)
        curr_conf = 55 if current_reading else 0

    # If we have readings but no units, compute from readings
    if not total_units and previous_reading and current_reading:
        if current_reading > previous_reading:
            total_units = current_reading - previous_reading
            units_conf = 70  # Computed confidence

    # Build per-field results
    fields = {
        'consumer_number': FieldResult(
            consumer_number, consumer_conf,
            'ocr_direct' if consumer_conf > 60 else 'regex_fallback',
        ),
        'service_number': FieldResult(
            service_number, service_conf,
            'ocr_direct' if service_conf > 0 else 'default',
        ),
        'billing_month': FieldResult(
            billing_month, month_conf,
            'ocr_direct' if month_conf > 60 else 'regex_fallback',
        ),
        'billing_date': FieldResult(
            billing_date, bdate_conf,
            'ocr_direct' if bdate_conf > 0 else 'default',
        ),
        'due_date': FieldResult(
            due_date, ddate_conf,
            'ocr_direct' if ddate_conf > 0 else 'default',
        ),
        'total_units': FieldResult(
            total_units, units_conf,
            'ocr_direct' if units_conf > 60 else ('computed' if units_conf == 70 else 'regex_fallback'),
        ),
        'bill_amount': FieldResult(
            bill_amount, amount_conf,
            'ocr_direct' if amount_conf > 60 else 'regex_fallback',
        ),
        'previous_reading': FieldResult(
            previous_reading, prev_conf,
            'ocr_direct' if prev_conf > 60 else 'regex_fallback',
        ),
        'current_reading': FieldResult(
            current_reading, curr_conf,
            'ocr_direct' if curr_conf > 60 else 'regex_fallback',
        ),
    }

    # --- Plausibility bonuses ---
    if total_units and 1 <= total_units <= 10000:
        fields['total_units'].confidence = min(100, fields['total_units'].confidence + 10)
    if bill_amount and 50 <= bill_amount <= 50000:
        fields['bill_amount'].confidence = min(100, fields['bill_amount'].confidence + 10)

    # --- Cross-validation bonus ---
    if (current_reading and previous_reading and total_units and
            current_reading > previous_reading):
        computed = current_reading - previous_reading
        if total_units > 0 and abs(computed - total_units) / total_units <= 0.05:
            for fname in ['total_units', 'current_reading', 'previous_reading']:
                fields[fname].confidence = min(100, fields[fname].confidence + 8)

    # --- Run validation ---
    validation_results = {}
    cross_validation = {}
    if _HAS_VALIDATOR:
        plain_data = {k: v.value for k, v in fields.items()}
        validation_results = validate_bill_data(plain_data)
        cross_validation = cross_validate_readings(plain_data)

        # Apply confidence penalties from validation
        penalties = compute_confidence_penalty(validation_results)
        for fname, penalty in penalties.items():
            if fname in fields:
                fields[fname].confidence = max(0, fields[fname].confidence - penalty)

    # --- Overall confidence ---
    fields_found = sum(1 for f in fields.values() if f.value is not None)
    field_confidences = [f.confidence for f in fields.values() if f.value is not None]
    overall_confidence = (
        sum(field_confidences) / len(field_confidences) if field_confidences else 0
    )

    # Cap if critical fields missing
    has_critical = all(fields[f].value is not None
                       for f in ['total_units', 'bill_amount', 'consumer_number', 'billing_month'])
    if not has_critical:
        overall_confidence = min(65, overall_confidence)

    overall_confidence = max(0, min(100, overall_confidence))

    if overall_confidence >= 70:
        confidence_label = 'high'
    elif overall_confidence >= 40:
        confidence_label = 'medium'
    else:
        confidence_label = 'low'

    # Log field extraction results
    found_names = [k for k, v in fields.items() if v.value is not None]
    missing_names = [k for k, v in fields.items() if v.value is None]
    ocr_logger.info(f"Fields FOUND ({len(found_names)}): {', '.join(found_names)}")
    ocr_logger.info(f"Fields MISSING ({len(missing_names)}): {', '.join(missing_names)}")

    conf_summary = ', '.join(
        f"{k}={v.confidence:.0f}%" for k, v in fields.items() if v.value is not None
    )
    ocr_logger.info(f"Per-field confidence: {conf_summary}")

    if validation_results:
        val_warnings = {k: v['warnings'] for k, v in validation_results.items() if v['warnings']}
        val_errors = {k: v['errors'] for k, v in validation_results.items() if v['errors']}
        if val_warnings:
            ocr_logger.warning(f"Validation warnings: {val_warnings}")
        if val_errors:
            ocr_logger.warning(f"Validation errors: {val_errors}")

    elapsed = time.time() - pipeline_start
    ocr_logger.info(
        f"Pipeline complete in {elapsed:.1f}s, "
        f"confidence={overall_confidence:.0f}% ({confidence_label})"
    )

    # Build response
    result = {
        'consumer_number': fields['consumer_number'].to_dict(),
        'service_number': fields['service_number'].to_dict(),
        'billing_month': fields['billing_month'].to_dict(),
        'billing_date': fields['billing_date'].to_dict(),
        'due_date': fields['due_date'].to_dict(),
        'total_units': fields['total_units'].to_dict(),
        'bill_amount': fields['bill_amount'].to_dict(),
        'previous_reading': fields['previous_reading'].to_dict(),
        'current_reading': fields['current_reading'].to_dict(),
        'electricity_board': board,
        'overall_confidence': round(overall_confidence, 1),
        'overall_confidence_label': confidence_label,
        'image_quality': quality_result,
        'ocr_engine': 'PaddleOCR',
        'raw_text_length': len(raw_text),
        'fields_found': fields_found,
        'extraction_timestamp': datetime.now().isoformat(),
        'validation': validation_results,
        'cross_validation': cross_validation,
        # Legacy compatibility fields
        'confidence': confidence_label,
        'confidence_score': round(overall_confidence, 1),
    }

    return result


# ---------------------------------------------------------------------------
# Bill Data → Energy Records Conversion
# ---------------------------------------------------------------------------

def bill_data_to_energy_records(bill_data, billing_date=None):
    """Convert extracted bill data into daily energy records for ML processing.

    Distributes monthly units across days with realistic daily variation
    that is unique per bill.

    Args:
        bill_data: Dict from extract_bill_data(). Fields can be plain values
                   or dicts with {'value': ..., 'confidence': ...}.
        billing_date: Optional override for the billing end date.

    Returns:
        list: List of dicts with 'date' and 'units' keys (daily records).
    """
    # Handle both new (dict with value/confidence) and legacy (plain) formats
    def _get_val(field):
        v = bill_data.get(field)
        if isinstance(v, dict):
            return v.get('value')
        return v

    total_units = _get_val('total_units')
    if not total_units or total_units <= 0:
        return []

    # Parse billing month to determine date range
    billing_month_str = _get_val('billing_month')
    if billing_date:
        end_date = billing_date
    elif billing_month_str:
        end_date = _parse_billing_month(billing_month_str)
    else:
        end_date = datetime.now()

    if end_date is None:
        end_date = datetime.now()

    # Assume 30-day billing cycle
    days_in_cycle = 30
    daily_avg = total_units / days_in_cycle

    records = []
    # Use current timestamp for seed so every upload produces unique patterns
    random.seed(int(datetime.now().timestamp() * 1000) % (2**31))

    noise_scale = daily_avg * 0.25  # ±25% variation

    for i in range(days_in_cycle):
        day_date = end_date - timedelta(days=days_in_cycle - 1 - i)

        # Weekday/weekend pattern
        weekday = day_date.weekday()
        if weekday >= 5:  # weekend
            day_factor = random.uniform(1.05, 1.25)
        elif weekday in [0, 4]:  # Monday/Friday
            day_factor = random.uniform(0.92, 1.08)
        else:  # mid-week
            day_factor = random.uniform(0.82, 1.02)

        # Add consumption-proportional noise
        noise = random.gauss(0, noise_scale * 0.4)
        day_units = round(daily_avg * day_factor + noise, 2)
        day_units = max(0.5, day_units)  # floor

        records.append({
            'date': day_date.strftime('%Y-%m-%dT00:00:00'),
            'units': day_units
        })

    # Normalize so total matches the bill's actual total
    generated_total = sum(r['units'] for r in records)
    if generated_total > 0:
        scale_factor = total_units / generated_total
        for r in records:
            r['units'] = round(r['units'] * scale_factor, 2)

    ocr_logger.info(
        f"Generated {len(records)} records, "
        f"total={sum(r['units'] for r in records):.1f} units "
        f"(bill total={total_units})"
    )

    return records


def _parse_billing_month(month_str):
    """Try to parse a billing month string into a datetime."""
    formats = [
        '%B %Y', '%b %Y', '%B-%Y', '%b-%Y',
        '%m/%Y', '%m-%Y',
        '%d/%m/%Y', '%d-%m-%Y',
        '%Y-%m-%d', '%m/%d/%Y',
    ]
    cleaned = month_str.strip()

    for fmt in formats:
        try:
            return datetime.strptime(cleaned, fmt)
        except ValueError:
            continue

    # Try to extract month name + year
    match = re.search(
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'[a-z]*[\s\-,]*(\d{4})',
        cleaned, re.IGNORECASE
    )
    if match:
        try:
            return datetime.strptime(
                f"{match.group(1)} {match.group(2)}", "%b %Y"
            )
        except ValueError:
            pass

    return None


def free_paddleocr_reader():
    """Explicitly release PaddleOCR resources to save memory in low-RAM environments."""
    global _paddleocr_reader
    if _paddleocr_reader is not None:
        import gc
        ocr_logger.info("Releasing PaddleOCR resources...")
        try:
            del _paddleocr_reader
        except Exception as e:
            ocr_logger.warning(f"Error deleting PaddleOCR reader: {e}")
        _paddleocr_reader = None
        gc.collect()
        ocr_logger.info("PaddleOCR resources successfully released.")

