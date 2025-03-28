// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Upload files from disk to a remote server over HTTP.
//!
//! Download files from a remote HTTP server to disk.

use futures_util::TryStreamExt;
use serde::{ser::Serializer, Serialize};
use tauri::{
    command,
    ipc::Channel,
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};
use tokio::{
    fs::File,
    io::{AsyncWriteExt, BufWriter},
};
use tokio_util::codec::{BytesCodec, FramedRead};

use read_progress_stream::ReadProgressStream;

use std::collections::HashMap;

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Request(#[from] reqwest::Error),
    #[error("{0}")]
    ContentLength(String),
    #[error("request failed with status code {0}: {1}")]
    HttpErrorCode(u16, String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    progress: u64,
    progress_total: u64,
    total: u64,
    transfer_speed: u64,
}

#[command]
async fn download(
    url: &str,
    file_path: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
    on_progress: Channel<ProgressPayload>,
) -> Result<()> {
    let client = reqwest::Client::new();
    let mut request = if let Some(body) = body {
        client.post(url).body(body)
    } else {
        client.get(url)
    };
    // Loop trought the headers keys and values
    // and add them to the request object.
    for (key, value) in headers {
        request = request.header(&key, value);
    }

    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(Error::HttpErrorCode(
            response.status().as_u16(),
            response.text().await.unwrap_or_default(),
        ));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = BufWriter::new(File::create(file_path).await?);
    let mut stream = response.bytes_stream();

    let mut stats = TransferStats::default();
    while let Some(chunk) = stream.try_next().await? {
        file.write_all(&chunk).await?;
        stats.record_chunk_transfer(chunk.len());
        let _ = on_progress.send(ProgressPayload {
            progress: chunk.len() as u64,
            progress_total: stats.total_transferred,
            total,
            transfer_speed: stats.transfer_speed,
        });
    }
    file.flush().await?;

    Ok(())
}

#[command]
pub async fn upload(
    url: &str,
    file_path: &str,
    headers: HashMap<String, String>,
    on_progress: Channel<ProgressPayload>,
) -> Result<String> {
    // Read the file
    let file = File::open(file_path).await?;
    let file_len = file.metadata().await.unwrap().len();

    // Create the request and attach the file to the body
    let client = reqwest::Client::new();
    let mut request = client
        .put(url)
        .header(reqwest::header::CONTENT_LENGTH, file_len)
        .body(file_to_body(on_progress, file));

    // Loop through the headers keys and values
    // and add them to the request object.
    for (key, value) in headers {
        request = request.header(&key, value);
    }

    let response = request.send().await?;
    if response.status().is_success() {
        response.text().await.map_err(Into::into)
    } else {
        Err(Error::HttpErrorCode(
            response.status().as_u16(),
            response.text().await.unwrap_or_default(),
        ))
    }
}

fn file_to_body(channel: Channel<ProgressPayload>, file: File) -> reqwest::Body {
    let stream = FramedRead::new(file, BytesCodec::new()).map_ok(|r| r.freeze());

    let mut stats = TransferStats::default();
    reqwest::Body::wrap_stream(ReadProgressStream::new(
        stream,
        Box::new(move |progress, total| {
            stats.record_chunk_transfer(progress as usize);
            let _ = channel.send(ProgressPayload {
                progress,
                progress_total: stats.total_transferred,
                total,
                transfer_speed: stats.transfer_speed,
            });
        }),
    ))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    println!("init upload");
    PluginBuilder::new("upload")
        .invoke_handler(tauri::generate_handler![download, upload])
        .build()
}

use std::time::Instant;

// The TransferStats struct tracks both transfer speed and cumulative transfer progress.
pub struct TransferStats {
    accumulated_chunk_len: usize, // Total length of chunks transferred in the current period
    accumulated_time: u128,       // Total time taken for the transfers in the current period
    pub transfer_speed: u64,      // Calculated transfer speed in bytes per second
    pub total_transferred: u64,   // Cumulative total of all transferred data
    start_time: Instant,          // Time when the current period started
    granularity: u32, // Time period (in milliseconds) over which the transfer speed is calculated
}

impl TransferStats {
    // Initializes a new TransferStats instance with the specified granularity.
    pub fn start(granularity: u32) -> Self {
        Self {
            accumulated_chunk_len: 0,
            accumulated_time: 0,
            transfer_speed: 0,
            total_transferred: 0,
            start_time: Instant::now(),
            granularity,
        }
    }
    // Records the transfer of a data chunk and updates both transfer speed and total progress.
    pub fn record_chunk_transfer(&mut self, chunk_len: usize) {
        let now = Instant::now();
        let it_took = now.duration_since(self.start_time).as_millis();
        self.accumulated_chunk_len += chunk_len;
        self.total_transferred += chunk_len as u64;
        self.accumulated_time += it_took;

        // Calculate transfer speed if accumulated time exceeds granularity.
        if self.accumulated_time >= self.granularity as u128 {
            self.transfer_speed =
                (self.accumulated_chunk_len as u128 / self.accumulated_time * 1024) as u64;
            self.accumulated_chunk_len = 0;
            self.accumulated_time = 0;
        }

        // Reset the start time for the next period.
        self.start_time = now;
    }
}

// Provides a default implementation for TransferStats with a granularity of 500 milliseconds.
impl Default for TransferStats {
    fn default() -> Self {
        Self::start(500) // Default granularity is 500 ms
    }
}
