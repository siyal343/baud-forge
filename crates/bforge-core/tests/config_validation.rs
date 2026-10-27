//! Semantic validation of `.bforge.toml` (F1.5.1).

use bforge_core::ProjectConfig;

const EXAMPLE: &str = include_str!("../../bforge-core/examples/cubesat.bforge.toml");

fn parse(text: &str) -> ProjectConfig {
    bforge_core::parse(text).expect("the test document must parse")
}

fn issue_paths(config: &ProjectConfig) -> Vec<String> {
    config
        .validate()
        .into_iter()
        .map(|issue| issue.path)
        .collect()
}

#[test]
fn the_example_workspace_is_clean() {
    assert_eq!(parse(EXAMPLE).validate(), vec![]);
}

#[test]
fn duplicate_port_ids_are_reported_on_the_second_one() {
    let config = parse(EXAMPLE);
    let mut config = config;
    config.ports.push(config.ports[0].clone());
    assert_eq!(issue_paths(&config), vec!["ports[1].id".to_string()]);
}

#[test]
fn a_baud_rate_outside_the_uart_range_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].baud_rate = 20_000_000;
    assert_eq!(issue_paths(&config), vec!["ports[0].baud_rate".to_string()]);
}

#[test]
fn an_unknown_framing_mode_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].framing.mode = "cobs2".into();
    assert_eq!(
        issue_paths(&config),
        vec!["ports[0].framing.mode".to_string()]
    );
}

#[test]
fn delimiter_mode_without_a_delimiter_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].framing.mode = "delimiter".into();
    config.ports[0].framing.delimiter = None;
    assert_eq!(
        issue_paths(&config),
        vec!["ports[0].framing.delimiter".to_string()]
    );
}

#[test]
fn an_unknown_checksum_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].framing.crc = Some("crc32".into());
    assert_eq!(
        issue_paths(&config),
        vec!["ports[0].framing.crc".to_string()]
    );
}

#[test]
fn a_port_without_a_binding_or_a_path_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].match_vid_pid = None;
    assert_eq!(
        issue_paths(&config),
        vec!["ports[0].match_vid_pid".to_string()]
    );
}

#[test]
fn a_malformed_usb_tuple_is_reported() {
    let mut config = parse(EXAMPLE);
    config.ports[0].match_vid_pid = Some("0403-6010".into());
    assert_eq!(
        issue_paths(&config),
        vec!["ports[0].match_vid_pid".to_string()]
    );
}

#[test]
fn a_command_for_an_unknown_port_is_reported() {
    let mut config = parse(EXAMPLE);
    config.commands[0].port = "eps_node".into();
    assert_eq!(issue_paths(&config), vec!["commands[0].port".to_string()]);
}

#[test]
fn a_shared_hotkey_is_reported() {
    let mut config = parse(EXAMPLE);
    let mut second = config.commands[0].clone();
    second.name = "Second command".into();
    config.commands.push(second);
    assert_eq!(issue_paths(&config), vec!["commands[1].hotkey".to_string()]);
}

#[test]
fn an_unknown_field_type_and_a_missing_enum_options_list_are_reported() {
    let mut config = parse(EXAMPLE);
    config.commands[0].fields[0].kind = "u64_be".into();
    config.commands[0].fields[2].options = None;
    assert_eq!(
        issue_paths(&config),
        vec![
            "commands[0].fields[0].type".to_string(),
            "commands[0].fields[2].options".to_string()
        ]
    );
}

#[test]
fn an_alert_without_actions_is_reported() {
    let mut config = parse(EXAMPLE);
    config.alerts[0].actions.clear();
    assert_eq!(issue_paths(&config), vec!["alerts[0].actions".to_string()]);
}

#[test]
fn watching_an_elf_file_without_a_path_is_reported() {
    let mut config = parse(EXAMPLE);
    config.workspace.elf_path = None;
    assert_eq!(issue_paths(&config), vec!["workspace.elf_path".to_string()]);
}

#[test]
fn several_problems_arrive_in_document_order() {
    let mut config = parse(EXAMPLE);
    config.ports[0].baud_rate = 0;
    config.alerts[0].condition = String::new();
    assert_eq!(
        issue_paths(&config),
        vec![
            "ports[0].baud_rate".to_string(),
            "alerts[0].condition".to_string()
        ]
    );
}
