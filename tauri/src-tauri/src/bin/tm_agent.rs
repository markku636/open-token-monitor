use clap::Parser;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    token_monitor_lib::cli::load_dotenv();
    let cli = token_monitor_lib::cli::Cli::parse_from(token_monitor_lib::cli::normalize_args(
        std::env::args_os().collect(),
    ));
    token_monitor_lib::cli::run(cli).await
}
