use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

fn mock_http_many(
    responses: Vec<(String, String, String)>,
) -> (Url, std::thread::JoinHandle<Vec<String>>) {
    use std::collections::VecDeque;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/complete",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let mut pending: VecDeque<(String, String, String)> = responses.into();
    let count = pending.len();
    let task = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (header, value) = line.split_once(':')?;
                    header
                        .eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut request_body = vec![0; length];
            reader.read_exact(&mut request_body).unwrap();
            let (status, headers, body) = pending.pop_front().unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            requests.push(format!(
                "{head}\r\n{}",
                String::from_utf8(request_body).unwrap()
            ));
        }
        requests
    });
    (endpoint, task)
}

fn mock_http(status: &str, headers: &str, body: &str) -> (Url, std::thread::JoinHandle<String>) {
    let (endpoint, task) = mock_http_many(vec![(
        status.to_owned(),
        headers.to_owned(),
        body.to_owned(),
    )]);
    (
        endpoint,
        std::thread::spawn(move || task.join().unwrap().remove(0)),
    )
}

#[tokio::test]
async fn maps_each_http_protocol_and_authenticates_directly() {
    let client = Completion::default();
    for (protocol, body, max_tokens) in [
        (
            Protocol::Responses,
            json!({"output": [{"content": [{"type": "output_text", "text": "  x"}]}]}),
            "max_output_tokens",
        ),
        (
            Protocol::ChatCompletions,
            json!({"choices": [{"message": {"content": "  x"}, "finish_reason": "stop"}]}),
            "max_completion_tokens",
        ),
        (
            Protocol::Messages,
            json!({"content": [{"type": "text", "text": "  x"}], "stop_reason": "end_turn"}),
            "max_tokens",
        ),
    ] {
        let (endpoint, server) = mock_http("200 OK", "", &body.to_string());
        let config = Config {
            protocol,
            url: endpoint.to_string(),
            model: "test-model".into(),
            api_key: "sample-key".into(),
        };
        let context = json!({"language": "Rust", "prefix": "fn f() {", "suffix": "}"});
        let hints = AtomicBool::new(true);
        let result = complete_http(
            client.http_client().unwrap(),
            &config,
            &endpoint,
            &context,
            "}",
            &hints,
        )
        .await
        .unwrap();
        assert_eq!(result.as_deref(), Some("  x"));
        let request = server.join().unwrap();
        let (head, data) = request.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /complete HTTP/"));
        let head = head.to_lowercase();
        if protocol == Protocol::Messages {
            assert!(head.contains("x-api-key: sample-key"));
            assert!(head.contains("anthropic-version: 2023-06-01"));
        } else {
            assert!(head.contains("authorization: bearer sample-key"));
        }
        let body: Value = serde_json::from_str(data).unwrap();
        assert_eq!(body["model"], "test-model");
        assert_eq!(body[max_tokens], 256);
        if protocol == Protocol::Messages {
            // Anthropic only thinks when asked, so no hints are needed.
            assert!(body.get("thinking").is_none() && body.get("reasoning_effort").is_none());
        } else {
            assert_eq!(body["thinking"]["type"], "disabled");
            if protocol == Protocol::Responses {
                assert_eq!(body["reasoning"]["effort"], "minimal");
            } else {
                assert_eq!(body["reasoning_effort"], "minimal");
            }
        }
        let input = if protocol == Protocol::Responses {
            assert_eq!(body["store"], false);
            &body["input"]
        } else if protocol == Protocol::ChatCompletions {
            &body["messages"][1]["content"]
        } else {
            &body["messages"][0]["content"]
        };
        assert_eq!(
            serde_json::from_str::<Value>(input.as_str().unwrap()).unwrap(),
            context
        );
    }
}

#[tokio::test]
async fn classifies_authentication_rate_limits_and_redirects() {
    let service = Completion::default();
    for (status, headers, expected) in [
        ("401 Unauthorized", "", Failure::Authentication),
        (
            "429 Too Many Requests",
            "Retry-After: 57\r\n",
            Failure::RateLimited,
        ),
        ("503 Service Unavailable", "", Failure::Unavailable),
        (
            "302 Found",
            "Location: https://example.invalid/other\r\n",
            Failure::Configuration,
        ),
        ("200 OK", "", Failure::InvalidResponse),
    ] {
        let (endpoint, server) = mock_http(status, headers, "{}");
        let config = Config {
            protocol: Protocol::Responses,
            url: endpoint.to_string(),
            model: "test".into(),
            api_key: "synthetic-key".into(),
        };
        let hints = AtomicBool::new(true);
        let err = complete_http(
            service.http_client().unwrap(),
            &config,
            &endpoint,
            &json!({}),
            "",
            &hints,
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(err.kind, expected);
        if expected == Failure::RateLimited {
            assert_eq!(err.retry_after, Some(Duration::from_secs(57)));
        }
    }
}

#[tokio::test]
async fn drops_reasoning_hints_when_the_provider_rejects_them() {
    let (endpoint, server) = mock_http_many(vec![
        (
            "400 Bad Request".into(),
            String::new(),
            json!({"error": {"message": "unknown field `thinking`", "param": "thinking"}})
                .to_string(),
        ),
        (
            "200 OK".into(),
            String::new(),
            json!({"output": [{"content": [{"type": "output_text", "text": "  x"}]}]}).to_string(),
        ),
    ]);
    let config = Config {
        protocol: Protocol::Responses,
        url: endpoint.to_string(),
        model: "test-model".into(),
        api_key: "sample-key".into(),
    };
    let hints = AtomicBool::new(true);
    let result = complete_http(
        Completion::default().http_client().unwrap(),
        &config,
        &endpoint,
        &json!({"prefix": "fn f() {"}),
        "",
        &hints,
    )
    .await
    .unwrap();
    assert_eq!(result.as_deref(), Some("  x"));
    assert!(!hints.load(Ordering::Relaxed), "hints should stay off");
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    let bodies = requests
        .iter()
        .map(|request| {
            serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(bodies[0]["thinking"]["type"], "disabled");
    assert!(bodies[1].get("thinking").is_none());
    assert!(bodies[1].get("reasoning").is_none());
}

#[test]
fn treats_a_truncated_answer_as_unusable() {
    assert_eq!(
        reply_text(
            Protocol::Responses,
            &json!({"status": "incomplete", "incomplete_details": {"reason": "length"}})
        ),
        Err(Failure::InvalidResponse)
    );
    assert_eq!(
        reply_text(
            Protocol::ChatCompletions,
            &json!({"choices": [{"message": {"content": ""}, "finish_reason": "length"}]})
        ),
        Err(Failure::InvalidResponse)
    );
    assert_eq!(
        reply_text(
            Protocol::Messages,
            &json!({"content": [], "stop_reason": "max_tokens"})
        ),
        Err(Failure::InvalidResponse)
    );
}

#[test]
fn reasoning_hints_survive_a_reset() {
    let completion = Completion::default();
    completion.hints.store(false, Ordering::Relaxed);
    completion.reset();
    assert!(completion.hints.load(Ordering::Relaxed));
}

#[test]
fn rejects_stale_requests_and_cancels_a_superseded_http_future() {
    let completion = Completion::default();
    let token = completion.start("main", 1).unwrap();
    completion.stop("main", 2);
    assert!(token.is_cancelled());
    assert!(completion.start("main", 2).is_none());
    let later = completion.start("main", 3).unwrap();
    completion.stop("main", 1);
    assert!(!later.is_cancelled());
    completion.reset();
    assert!(later.is_cancelled());
    assert!(completion.start("main", 4).is_some());
}

#[tokio::test]
async fn deadlines_classify_timeouts_and_drop_cancelled_requests() {
    let token = CancellationToken::new();
    let timeout = within_deadline(&token, Duration::from_millis(1), std::future::pending())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(timeout.kind, Failure::Timeout);
    token.cancel();
    let cancelled = within_deadline(&token, Duration::from_secs(2), async {
        Ok(Some("late".into()))
    })
    .await;
    assert!(cancelled.is_none());
}

#[test]
fn cooldown_honors_retry_after_and_resets_after_success() {
    let mut cooldown = Cooldown::default();
    let now = Instant::now();
    let rate_limit = Err(RequestError {
        kind: Failure::RateLimited,
        retry_after: Some(Duration::from_secs(57)),
    });
    cooldown.record(&rate_limit, now);
    assert_eq!(cooldown.allowed(false, now), Err(Failure::Backoff));
    // A manual request is an explicit retry, so it skips the automatic backoff.
    assert!(cooldown.allowed(true, now).is_ok());
    assert!(cooldown
        .allowed(false, now + Duration::from_secs(57))
        .is_ok());
    cooldown.record(&Err(Failure::Timeout.into()), now + Duration::from_secs(57));
    cooldown.record(
        &Err(Failure::Unavailable.into()),
        now + Duration::from_secs(58),
    );
    assert_eq!(
        cooldown.allowed(false, now + Duration::from_secs(59)),
        Err(Failure::Backoff)
    );
    assert!(cooldown
        .allowed(true, now + Duration::from_secs(59))
        .is_ok());
    cooldown.record(&Ok(Some("x".into())), now);
    assert!(cooldown.allowed(false, now).is_ok());
    cooldown.record(&Err(Failure::Authentication.into()), now);
    assert_eq!(cooldown.allowed(false, now), Err(Failure::Backoff));
    assert_eq!(cooldown.allowed(true, now), Err(Failure::Authentication));
}

#[test]
fn caps_the_rate_limit_backoff_at_one_minute() {
    let mut cooldown = Cooldown::default();
    let now = Instant::now();
    cooldown.record(
        &Err(RequestError {
            kind: Failure::RateLimited,
            retry_after: Some(Duration::from_secs(86_400)),
        }),
        now,
    );
    assert!(cooldown
        .allowed(false, now + MAX_RETRY_AFTER - Duration::from_millis(1))
        .is_err());
    assert!(cooldown.allowed(false, now + MAX_RETRY_AFTER).is_ok());
}

#[test]
fn appends_the_protocol_path_and_redacts_the_api_key() {
    let config = |url: &str| Config {
        url: url.into(),
        model: "model".into(),
        api_key: "secret-key".into(),
        ..Config::default()
    };
    assert_eq!(
        config("https://api.example").endpoint().unwrap().as_str(),
        "https://api.example/v1/responses"
    );
    assert_eq!(
        config("https://api.example/").endpoint().unwrap().as_str(),
        "https://api.example/v1/responses"
    );
    // Settings from earlier builds already hold the full endpoint.
    assert_eq!(
        config("https://api.example/v1/responses")
            .endpoint()
            .unwrap()
            .as_str(),
        "https://api.example/v1/responses"
    );
    // A base URL that already carries a version keeps it instead of nesting another one.
    for (url, protocol, expected) in [
        (
            "https://api.openai.com/v1",
            Protocol::Responses,
            "https://api.openai.com/v1/responses",
        ),
        (
            "https://api.openai.com/v1",
            Protocol::ChatCompletions,
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "https://api.anthropic.com/v1",
            Protocol::Messages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://ark.example/api/v3",
            Protocol::ChatCompletions,
            "https://ark.example/api/v3/chat/completions",
        ),
        (
            "https://ark.example/api/plan",
            Protocol::Messages,
            "https://ark.example/api/plan/v1/messages",
        ),
    ] {
        let endpoint = Config {
            protocol,
            ..config(url)
        }
        .endpoint()
        .unwrap();
        assert_eq!(endpoint.as_str(), expected, "{url} {protocol:?}");
    }
    for (protocol, path) in [
        (Protocol::ChatCompletions, "/v1/chat/completions"),
        (Protocol::Messages, "/v1/messages"),
    ] {
        let endpoint = Config {
            protocol,
            ..config("https://api.example/base")
        }
        .endpoint()
        .unwrap();
        assert_eq!(endpoint.path(), format!("/base{path}"));
    }
    for url in [
        "http://api.example",
        "https://user:pass@api.example",
        "https://api.example/v1/responses?access_token=secret",
        "",
    ] {
        assert!(config(url).endpoint().is_none(), "{url}");
    }
    assert!(!format!("{:?}", config("https://api.example")).contains("secret-key"));
    assert!(Config {
        api_key: String::new(),
        ..config("https://api.example")
    }
    .validate()
    .is_err());
    assert!(config("https://api.example").validate().is_ok());
    let parsed: Config = serde_json::from_str(
        r#"{"protocol":"chatCompletions","url":"https://api.example","model":"m","apiKey":"k"}"#,
    )
    .unwrap();
    assert_eq!(parsed.protocol, Protocol::ChatCompletions);
    assert_eq!(parsed.api_key, "k");
    assert_eq!(serde_json::to_value(&parsed).unwrap()["apiKey"], "k");
    // Older settings without a key remain readable through serde defaults.
    let legacy: Config = serde_json::from_str(r#"{"url":"https://api.example"}"#).unwrap();
    assert!(legacy.api_key.is_empty());
}

#[test]
fn validates_and_normalizes_insertion_whitespace() {
    assert_eq!(
        normalize("    value\n}", "\n}").as_deref(),
        Some("    value")
    );
    assert_eq!(normalize("call()", ")").as_deref(), Some("call()"));
    assert_eq!(normalize("value)", ")").as_deref(), Some("value"));
    assert_eq!(normalize("```rust\n  x\n```", "").as_deref(), Some("  x"));
    assert!(normalize("Here is the code:\n  x", "").is_none());
    assert!(normalize("\n   ", "").is_none());
    assert_eq!(
        reply_text(
            Protocol::ChatCompletions,
            &json!({
                "choices": [{"message": {"content": "part"}, "finish_reason": "length"}]
            })
        ),
        Err(Failure::InvalidResponse)
    );
}

#[test]
fn denies_ignored_credentials_symlink_targets_and_escapes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let project = Project {
        id: "p".into(),
        name: "example".into(),
        root: root.to_str().unwrap().into(),
    };
    std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
    for name in ["main.ts", "ignored.ts", ".env.local", "key.pem"] {
        std::fs::write(root.join(name), "synthetic").unwrap();
    }
    assert!(eligible_path(&project, "main.ts").is_some());
    for name in ["ignored.ts", ".env.local", "key.pem", "../outside.ts"] {
        assert!(eligible_path(&project, name).is_none());
    }
    #[cfg(unix)]
    {
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("outside.ts")).unwrap();
        std::os::unix::fs::symlink(root.join(".env.local"), root.join("alias.ts")).unwrap();
        assert!(eligible_path(&project, "outside.ts").is_none());
        assert!(eligible_path(&project, "alias.ts").is_none());
    }
}

struct EvaluationCase {
    language: &'static str,
    prefix: &'static str,
    suffix: &'static str,
    related: &'static [&'static str],
    expected: Option<&'static str>,
}

const EVALUATION: &[EvaluationCase] = &[
    EvaluationCase {
        language: "TypeScript",
        prefix: "function clamp(n: number, min: number, max: number) {\n  return Math.",
        suffix: "\n}\n",
        related: &[],
        expected: Some(r"^(?:max\(min,\s*Math\.min\(max,\s*n\)\)|min\(max,\s*Math\.max\(min,\s*n\)\));?$"),
    },
    EvaluationCase {
        language: "TypeScript",
        prefix: "import { loadProfile } from './profiles'\nexport async function title(userId: string) {\n  const profile = await loadProfile(",
        suffix: ")\n  return profile.displayName\n}\n",
        related: &["export async function loadProfile(options: { accountId: string }): Promise<Profile> {"],
        expected: Some(r"^\{\s*accountId\s*:\s*userId\s*,?\s*\}$"),
    },
    EvaluationCase {
        language: "Python",
        prefix: "def is_even(n: int) -> bool:\n    return n % 2 ",
        suffix: "\n\nassert is_even(4)",
        related: &[],
        expected: Some(r"^==\s*0$"),
    },
    EvaluationCase {
        language: "Python",
        prefix: "def first_or_none(items):\n    # Return None when there are no items, otherwise return the first item.\n    ",
        suffix: "\n\nassert first_or_none([]) is None\nassert first_or_none([10, 20]) == 10\n",
        related: &[],
        expected: Some(r"(?m)^(?:if not items:\n[ \t]+return None\n[ \t]+return items\[0\]|return items\[0\] if items else None)$"),
    },
    EvaluationCase {
        language: "Python",
        prefix: "from records import find_record\n\ndef label(record_id: int):\n    record = find_record(",
        suffix: ")\n    return record.name\n",
        related: &["def find_record(*, lookup_id: int) -> Record:"],
        expected: Some(r"^lookup_id\s*=\s*record_id$"),
    },
    EvaluationCase {
        language: "Rust",
        prefix: "fn double_first(values: &[i32]) -> Option<i32> {\n    values.first().map(",
        suffix: ")\n}\n",
        related: &[],
        expected: Some(r"^\|&?(?:x|n|value|v)\|\s*(?:2\s*\*\s*\*?\w+|\*?\w+\s*\*\s*2)$"),
    },
    EvaluationCase {
        language: "Rust",
        prefix: "use crate::profiles::fetch_profile;\nfn show(id: u64) -> String {\n    let entry = fetch_profile(",
        suffix: ").unwrap();\n    entry.display_name\n}\n",
        related: &["pub fn fetch_profile(id: ProfileId) -> Result<Profile, DbError> {", "pub struct ProfileId(pub u64);"],
        expected: Some(r"^(?:crate::profiles::)?ProfileId\(id\)$"),
    },
    EvaluationCase {
        language: "Python",
        prefix: "def answer():\n    return 42",
        suffix: "\n\nassert answer() == 42\n",
        related: &[],
        expected: None,
    },
];

#[test]
fn evaluation_rubric_is_valid() {
    for case in EVALUATION {
        if let Some(expected) = case.expected {
            regex::Regex::new(expected).unwrap();
        }
    }
}

#[tokio::test]
#[ignore = "requires explicit cloud endpoint and key; sends only synthetic fixtures"]
async fn model_accuracy_evaluation() {
    let protocol = std::env::var("GAZE_AI_EVAL_PROTOCOL").expect("set GAZE_AI_EVAL_PROTOCOL");
    let config = Config {
        protocol: serde_json::from_value(json!(protocol))
            .expect("responses, chatCompletions, or messages"),
        url: std::env::var("GAZE_AI_EVAL_URL").expect("set GAZE_AI_EVAL_URL"),
        model: std::env::var("GAZE_AI_EVAL_MODEL").expect("set GAZE_AI_EVAL_MODEL"),
        api_key: std::env::var("GAZE_AI_EVAL_API_KEY").expect("set GAZE_AI_EVAL_API_KEY"),
    };
    assert!(valid_key(&config.api_key), "invalid evaluation key");
    let endpoint = config.endpoint().expect("use a valid HTTPS endpoint");
    let service = Completion::default();
    let client = service.http_client().unwrap();
    let hints = AtomicBool::new(true);
    let mut cross_file_scores = Vec::new();
    let mut regular_scores = Vec::new();
    for augmented in [false, true] {
        let mut accepted = 0;
        let mut cross_file = 0;
        let mut regular = 0;
        let mut empty = 0;
        let mut errors = 0;
        let mut elapsed = Vec::new();
        for case in EVALUATION {
            let input = json!({
                "language": case.language, "prefix": case.prefix, "suffix": case.suffix,
                "related": if augmented { case.related } else { &[] },
            });
            let start = Instant::now();
            let result = tokio::time::timeout(
                AUTO_DEADLINE,
                complete_http(client, &config, &endpoint, &input, case.suffix, &hints),
            )
            .await;
            elapsed.push(start.elapsed().as_millis());
            let passed = match result {
                Ok(Ok(Some(text))) => case.expected.is_some_and(|expected| {
                    regex::Regex::new(expected).unwrap().is_match(text.trim())
                }),
                Ok(Ok(None)) => {
                    empty += 1;
                    case.expected.is_none()
                }
                _ => {
                    errors += 1;
                    false
                }
            };
            if passed {
                accepted += 1;
                if case.related.is_empty() {
                    regular += 1;
                } else {
                    cross_file += 1;
                }
            }
        }
        elapsed.sort_unstable();
        let score = |q: usize| elapsed[(elapsed.len() * q).div_ceil(100) - 1];
        println!(
            "augmented={augmented} accepted={accepted}/{} cross_file={cross_file} empty={empty} request_errors={errors} mismatches={} p50_ms={} p95_ms={}",
            EVALUATION.len(), EVALUATION.len() - accepted - errors, score(50), score(95)
        );
        cross_file_scores.push(cross_file);
        regular_scores.push(regular);
    }
    assert!(
        cross_file_scores[1] > cross_file_scores[0],
        "no improvement on cross-file fixtures"
    );
    assert!(
        regular_scores[1] >= regular_scores[0],
        "regression on ordinary fixtures"
    );
}
