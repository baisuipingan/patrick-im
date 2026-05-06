use anyhow::{Context, Result, anyhow, bail};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Builder as S3ConfigBuilder, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt, stream};
use patrick_im_server::config::AppConfig;
use std::env;
use std::time::Instant;
use uuid::Uuid;

const DEFAULT_PARTS: usize = 32;
const DEFAULT_CHUNK_MIB: usize = 8;
const DEFAULT_ROUNDS: usize = 2;
const DEFAULT_CONCURRENCY: &[usize] = &[1, 2, 4, 6, 8, 10, 12, 16];

#[derive(Debug, Clone, Copy)]
enum EndpointMode {
    Public,
    Internal,
}

impl EndpointMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone)]
struct BenchArgs {
    mode: EndpointMode,
    parts: usize,
    chunk_mib: usize,
    rounds: usize,
    concurrency_values: Vec<usize>,
}

#[derive(Debug, Clone)]
struct BenchResult {
    concurrency: usize,
    round: usize,
    seconds: f64,
    mib_per_second: f64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = BenchArgs::parse()?;
    let config = AppConfig::from_env()?;
    let endpoint = match args.mode {
        EndpointMode::Public => config.rustfs_public_endpoint.clone(),
        EndpointMode::Internal => config.rustfs_endpoint.clone(),
    };
    let client = build_s3_client(
        &endpoint,
        &config.rustfs_access_key,
        &config.rustfs_secret_key,
    );

    let total_mib = args.parts * args.chunk_mib;
    println!(
        "relay bench: mode={} endpoint={} parts={} chunk={}MiB total={}MiB rounds={} concurrency={:?}",
        args.mode.as_str(),
        endpoint,
        args.parts,
        args.chunk_mib,
        total_mib,
        args.rounds,
        args.concurrency_values
    );

    let mut all_results = Vec::new();
    for &concurrency in &args.concurrency_values {
        for round in 1..=args.rounds {
            let result =
                run_single_bench(&client, &config.rustfs_bucket, &args, concurrency, round)
                    .await
                    .with_context(|| {
                        format!(
                            "bench failed for mode={} concurrency={} round={}",
                            args.mode.as_str(),
                            concurrency,
                            round
                        )
                    })?;
            println!(
                "mode={} concurrency={} round={} duration={:.2}s speed={:.2} MiB/s",
                args.mode.as_str(),
                result.concurrency,
                result.round,
                result.seconds,
                result.mib_per_second
            );
            all_results.push(result);
        }
    }

    println!();
    println!("summary:");
    for &concurrency in &args.concurrency_values {
        let samples = all_results
            .iter()
            .filter(|result| result.concurrency == concurrency)
            .collect::<Vec<_>>();
        if samples.is_empty() {
            continue;
        }

        let average_seconds =
            samples.iter().map(|sample| sample.seconds).sum::<f64>() / samples.len() as f64;
        let average_speed = samples
            .iter()
            .map(|sample| sample.mib_per_second)
            .sum::<f64>()
            / samples.len() as f64;
        let best_speed = samples
            .iter()
            .map(|sample| sample.mib_per_second)
            .fold(0.0_f64, f64::max);

        println!(
            "concurrency={} avg_duration={:.2}s avg_speed={:.2} MiB/s best_speed={:.2} MiB/s",
            concurrency, average_seconds, average_speed, best_speed
        );
    }

    if let Some(best) = all_results
        .iter()
        .max_by(|left, right| left.mib_per_second.total_cmp(&right.mib_per_second))
    {
        println!();
        println!(
            "best run: mode={} concurrency={} round={} speed={:.2} MiB/s duration={:.2}s",
            args.mode.as_str(),
            best.concurrency,
            best.round,
            best.mib_per_second,
            best.seconds
        );
    }

    Ok(())
}

impl BenchArgs {
    fn parse() -> Result<Self> {
        let mut mode = EndpointMode::Public;
        let mut parts = DEFAULT_PARTS;
        let mut chunk_mib = DEFAULT_CHUNK_MIB;
        let mut rounds = DEFAULT_ROUNDS;
        let mut concurrency_values = DEFAULT_CONCURRENCY.to_vec();

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--mode" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("missing value for --mode"))?;
                    mode = match value.as_str() {
                        "public" => EndpointMode::Public,
                        "internal" => EndpointMode::Internal,
                        _ => bail!("invalid --mode, expected public or internal"),
                    };
                }
                "--parts" => {
                    parts = parse_positive_usize(args.next(), "--parts")?;
                }
                "--chunk-mib" => {
                    chunk_mib = parse_positive_usize(args.next(), "--chunk-mib")?;
                }
                "--rounds" => {
                    rounds = parse_positive_usize(args.next(), "--rounds")?;
                }
                "--concurrency" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("missing value for --concurrency"))?;
                    concurrency_values = value
                        .split(',')
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(|item| item.parse::<usize>().context("invalid concurrency value"))
                        .collect::<Result<Vec<_>>>()?;
                    if concurrency_values.is_empty() {
                        bail!("--concurrency must not be empty");
                    }
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => bail!("unknown argument: {other}"),
            }
        }

        Ok(Self {
            mode,
            parts,
            chunk_mib,
            rounds,
            concurrency_values,
        })
    }
}

fn parse_positive_usize(value: Option<String>, flag: &str) -> Result<usize> {
    let raw = value.ok_or_else(|| anyhow!("missing value for {flag}"))?;
    let parsed = raw
        .parse::<usize>()
        .with_context(|| format!("invalid numeric value for {flag}: {raw}"))?;
    if parsed == 0 {
        bail!("{flag} must be greater than zero");
    }
    Ok(parsed)
}

fn print_help() {
    println!("Usage: cargo run --release --bin relay_bench -- [options]");
    println!("  --mode public|internal      Benchmark public RustFS endpoint or internal endpoint");
    println!("  --parts <n>                 Number of multipart chunks to upload");
    println!("  --chunk-mib <n>             Size of each part in MiB");
    println!("  --rounds <n>                Repetitions per concurrency value");
    println!("  --concurrency 1,2,4,6       Comma-separated list of concurrency values");
}

async fn run_single_bench(
    client: &Client,
    bucket: &str,
    args: &BenchArgs,
    concurrency: usize,
    round: usize,
) -> Result<BenchResult> {
    let object_key = format!(
        "bench/{}/{}/{}/{}-{}.bin",
        args.mode.as_str(),
        args.parts,
        args.chunk_mib,
        concurrency,
        Uuid::new_v4()
    );
    let create_response = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(&object_key)
        .content_type("application/octet-stream")
        .send()
        .await
        .context("failed to create multipart upload")?;
    let upload_id = create_response
        .upload_id()
        .ok_or_else(|| anyhow!("missing upload id"))?
        .to_owned();

    let part_size_bytes = args.chunk_mib * 1024 * 1024;
    let payload = Bytes::from(vec![0_u8; part_size_bytes]);
    let started_at = Instant::now();

    let upload_result = stream::iter(1..=args.parts)
        .map(|part_number| {
            let client = client.clone();
            let bucket = bucket.to_owned();
            let object_key = object_key.clone();
            let upload_id = upload_id.clone();
            let payload = payload.clone();
            async move {
                client
                    .upload_part()
                    .bucket(bucket)
                    .key(object_key)
                    .upload_id(upload_id)
                    .part_number(i32::try_from(part_number).context("part number overflow")?)
                    .body(ByteStream::from(payload))
                    .send()
                    .await
                    .with_context(|| format!("failed to upload part {part_number}"))?;
                Ok::<(), anyhow::Error>(())
            }
        })
        .buffer_unordered(concurrency)
        .try_collect::<Vec<_>>()
        .await;

    let elapsed = started_at.elapsed();

    let abort_result = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(&object_key)
        .upload_id(&upload_id)
        .send()
        .await;

    upload_result?;
    abort_result.context("failed to abort multipart upload after bench")?;

    let total_mib = (args.parts * args.chunk_mib) as f64;
    let seconds = elapsed.as_secs_f64();
    Ok(BenchResult {
        concurrency,
        round,
        seconds,
        mib_per_second: total_mib / seconds,
    })
}

fn build_s3_client(endpoint: &str, access_key: &str, secret_key: &str) -> Client {
    let credentials = Credentials::new(
        access_key.to_owned(),
        secret_key.to_owned(),
        None,
        None,
        "patrick-im-relay-bench",
    );
    let config = S3ConfigBuilder::new()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .endpoint_url(endpoint)
        .force_path_style(true)
        .credentials_provider(credentials)
        .build();
    Client::from_conf(config)
}
