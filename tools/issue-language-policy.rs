use std::env;

fn field_refusal(name: &str, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(format!("GitHub issue {name} must not be empty."));
    }

    let mut has_ascii_letter = false;
    for character in trimmed.chars() {
        if !character.is_alphabetic() {
            continue;
        }
        if !character.is_ascii() {
            return Some(format!(
                "GitHub issue {name} contains a non-English letter."
            ));
        }
        has_ascii_letter = true;
    }
    if !has_ascii_letter {
        return Some(format!(
            "GitHub issue {name} must contain English words."
        ));
    }
    None
}

fn issue_language_refusal(title: &str, body: &str) -> Option<String> {
    field_refusal("title", title).or_else(|| field_refusal("body", body))
}

fn self_test() {
    assert_eq!(
        issue_language_refusal(
            "Enforce English-only GitHub tasks",
            "Allow Markdown, `paths/file.rs`, https://t27.ai and emoji \u{1f680}.",
        ),
        None
    );
    assert!(
        issue_language_refusal("\u{041d}\u{043e}\u{0432}\u{0430}\u{044f} task", "English body")
            .is_some_and(|reason| reason.contains("title"))
    );
    assert!(
        issue_language_refusal(
            "English title",
            "English prefix, \u{043d}\u{043e}\u{0432}\u{0430}\u{044f} detail.",
        )
        .is_some_and(|reason| reason.contains("body"))
    );
    assert!(issue_language_refusal("", "English body").is_some());
    assert!(issue_language_refusal("English title", "12345").is_some());
    println!("GitHub issue language policy: self-test PASS");
}

fn main() {
    if env::args().any(|argument| argument == "--self-test") {
        self_test();
        return;
    }

    let title = env::var("ISSUE_TITLE").unwrap_or_default();
    let body = env::var("ISSUE_BODY").unwrap_or_default();
    if let Some(refusal) = issue_language_refusal(&title, &body) {
        eprintln!("{refusal}");
        std::process::exit(1);
    }
    println!("GitHub issue language policy: PASS");
}
