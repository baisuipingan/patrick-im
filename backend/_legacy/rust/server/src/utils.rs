use crate::protocol::is_previewable_image;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn sanitize_room_id(input: &str) -> String {
    let normalized = input
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| match ch {
            'a'..='z' | '0'..='9' | '-' | '_' => ch,
            _ => '-',
        })
        .collect::<String>();

    let mut compact = String::with_capacity(normalized.len());
    let mut last_dash = false;
    for ch in normalized.chars() {
        if ch == '-' {
            if !last_dash {
                compact.push(ch);
            }
            last_dash = true;
        } else {
            compact.push(ch);
            last_dash = false;
        }
    }

    let compact = compact.chars().take(64).collect::<String>();
    if compact.trim_matches('-').is_empty() {
        "lobby".to_owned()
    } else {
        compact.trim_matches('-').to_owned()
    }
}

pub fn sanitize_nickname(input: &str, fallback: &str) -> String {
    let normalized = input
        .trim()
        .replace(['<', '>'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let limited = normalized.chars().take(24).collect::<String>();
    if limited.is_empty() {
        fallback.to_owned()
    } else {
        limited
    }
}

pub fn sanitize_file_name(input: &str) -> String {
    let normalized = input
        .trim()
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '"' | '*' | '?' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect::<String>();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let limited = normalized.chars().take(120).collect::<String>();
    if limited.is_empty() {
        "unnamed-file".to_owned()
    } else {
        limited
    }
}

pub fn build_object_key(room_id: &str, file_id: &str, file_name: &str) -> String {
    format!(
        "rooms/{room_id}/{file_id}/{}",
        sanitize_file_name(file_name)
    )
}

pub fn previewable_from_content_type(content_type: &str) -> bool {
    is_previewable_image(content_type)
}

pub fn encode_content_disposition_name(file_name: &str) -> String {
    let mut encoded = String::new();
    for byte in file_name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{byte:02X}"));
            }
        }
    }
    encoded
}
