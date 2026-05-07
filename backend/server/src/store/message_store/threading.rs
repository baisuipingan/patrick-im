const GLOBAL_THREAD_KEY: &str = "__global__";

pub fn normalize_target_id(client_id: &str, target_id: Option<String>) -> Option<String> {
    target_id.filter(|target| !target.is_empty() && target != client_id)
}

pub fn build_thread_key(client_id: &str, target_id: Option<&str>) -> String {
    match normalize_target_id(client_id, target_id.map(ToOwned::to_owned)) {
        None => GLOBAL_THREAD_KEY.to_owned(),
        Some(target_id) => {
            let mut pair = [client_id.to_owned(), target_id];
            pair.sort();
            format!("{}:{}", pair[0], pair[1])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_target_id_rejects_empty_and_self() {
        assert_eq!(normalize_target_id("alice", None), None);
        assert_eq!(normalize_target_id("alice", Some(String::new())), None);
        assert_eq!(normalize_target_id("alice", Some("alice".to_owned())), None);
        assert_eq!(
            normalize_target_id("alice", Some("bob".to_owned())),
            Some("bob".to_owned())
        );
    }

    #[test]
    fn build_thread_key_uses_global_for_room_chat() {
        assert_eq!(build_thread_key("alice", None), GLOBAL_THREAD_KEY);
        assert_eq!(build_thread_key("alice", Some("")), GLOBAL_THREAD_KEY);
        assert_eq!(build_thread_key("alice", Some("alice")), GLOBAL_THREAD_KEY);
    }

    #[test]
    fn build_thread_key_is_stable_for_direct_threads() {
        let left = build_thread_key("alice", Some("bob"));
        let right = build_thread_key("bob", Some("alice"));

        assert_eq!(left, "alice:bob");
        assert_eq!(left, right);
    }
}
