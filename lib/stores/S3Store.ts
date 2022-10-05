import {strict as assert} from 'node:assert'
import os from 'node:os'
import fs from 'node:fs'
import stream from 'node:stream'

import aws from 'aws-sdk'

import DataStore from './DataStore'
import {FileStreamSplitter} from '../models/StreamSplitter'
import {ERRORS, TUS_RESUMABLE} from '../constants'

import debug from 'debug'

const log = debug('tus-node-server:stores:s3store')
// Implementation (based on https://github.com/tus/tusd/blob/master/s3store/s3store.go)
//
// Once a new tus upload is initiated, multiple objects in S3 are created:
//
// First of all, a new info object is stored which contains (as Metadata) a JSON-encoded
// blob of general information about the upload including its size and meta data.
// This kind of objects have the suffix ".info" in their key.
//
// In addition a new multipart upload
// (http://docs.aws.amazon.com/AmazonS3/latest/dev/uploadobjusingmpu.html) is
// created. Whenever a new chunk is uploaded to tus-node-server using a PATCH request, a
// new part is pushed to the multipart upload on S3.
//
// If meta data is associated with the upload during creation, it will be added
// to the multipart upload and after finishing it, the meta data will be passed
// to the final object. However, the metadata which will be attached to the
// final object can only contain ASCII characters and every non-ASCII character
// will be replaced by a question mark (for example, "Menü" will be "Men?").
// However, this does not apply for the metadata returned by the `_getMetadata`
// function since it relies on the info object for reading the metadata.
// Therefore, HEAD responses will always contain the unchanged metadata, Base64-
// encoded, even if it contains non-ASCII characters.
//
// Once the upload is finished, the multipart upload is completed, resulting in
// the entire file being stored in the bucket. The info object, containing
// meta data is not deleted.
//
// Considerations
//
// In order to support tus' principle of resumable upload, S3's Multipart-Uploads
// are internally used.
// For each incoming PATCH request (a call to `write`), a new part is uploaded
// to S3.
class S3Store extends DataStore {
  bucket_name: any
  cache: any
  client: any
  part_size: any
  constructor(options: any) {
    super(options)
    this.extensions = ['creation', 'creation-with-upload', 'creation-defer-length']
    assert.ok(options.accessKeyId, '[S3Store] `accessKeyId` must be set')
    assert.ok(options.secretAccessKey, '[S3Store] `secretAccessKey` must be set')
    assert.ok(options.bucket, '[S3Store] `bucket` must be set')
    this.bucket_name = options.bucket
    this.part_size = options.partSize || 8 * 1024 * 1024
    // Cache object to save upload data
    // avoiding multiple http calls to s3
    this.cache = {}
    delete options.partSize
    this.client = new aws.S3({
      apiVersion: '2006-03-01',
      region: 'eu-west-1',
      ...options,
    })
    log('init')
  }

  /**
   * Check if the bucket exists in S3.
   *
   * @return {Promise}
   */
  _bucketExists() {
    return this.client
      .headBucket({Bucket: this.bucket_name})
      .promise()
      .then((data: any) => {
        if (!data) {
          throw new Error(`bucket "${this.bucket_name}" does not exist`)
        }

        log(`bucket "${this.bucket_name}" exists`)
        return data
      })
      .catch((error_: any) => {
        const error =
          error_.statusCode === 404
            ? new Error(`[S3Store] bucket "${this.bucket_name}" does not exist`)
            : new Error(error_)
        throw error
      })
  }

  /**
   * Creates a multipart upload on S3 attaching any metadata to it.
   * Also, a `${file_id}.info` file is created which holds some information
   * about the upload itself like: `upload_id`, `upload_length`, etc.
   *
   * @param  {Object}          file file instance
   * @return {Promise<Object>}      upload data
   */
  _initMultipartUpload(file: any) {
    log(`[${file.id}] initializing multipart upload`)
    const parsedMetadata = this._parseMetadataString(file.upload_metadata)
    const upload_data = {
      Bucket: this.bucket_name,
      Key: file.id,
      Metadata: {
        tus_version: TUS_RESUMABLE,
      },
    }
    if (file.upload_length !== undefined) {
      ;(upload_data.Metadata as any).upload_length = file.upload_length
    }

    if (file.upload_defer_length !== undefined) {
      ;(upload_data.Metadata as any).upload_defer_length = file.upload_defer_length
    }

    if (file.upload_metadata !== undefined) {
      ;(upload_data.Metadata as any).upload_metadata = file.upload_metadata
    }

    if (parsedMetadata.contentType) {
      ;(upload_data as any).ContentType = parsedMetadata.contentType.decoded
    }

    if (parsedMetadata.filename) {
      ;(upload_data.Metadata as any).original_name = parsedMetadata.filename.encoded
    }

    return this.client
      .createMultipartUpload(upload_data)
      .promise()
      .then((data: any) => {
        log(`[${file.id}] multipart upload created (${data.UploadId})`)
        return data.UploadId
      })
      .then((upload_id: any) => {
        return this._saveMetadata(file, upload_id)
      })
      .catch((error: any) => {
        throw error
      })
  }

  /**
   * Saves upload metadata to a `${file_id}.info` file on S3.
   * Please note that the file is empty and the metadata is saved
   * on the S3 object's `Metadata` field, so that only a `headObject`
   * is necessary to retrieve the data.
   *
   * @param  {Object}          file      file instance
   * @param  {String}          upload_id S3 upload id
   * @return {Promise<Object>}           upload data
   */
  _saveMetadata(file: any, upload_id: any) {
    log(`[${file.id}] saving metadata`)
    const metadata = {
      file: JSON.stringify(file),
      upload_id,
      tus_version: TUS_RESUMABLE,
    }
    return this.client
      .putObject({
        Bucket: this.bucket_name,
        Key: `${file.id}.info`,
        Body: '',
        Metadata: metadata,
      })
      .promise()
      .then(() => {
        log(`[${file.id}] metadata file saved`)
        return {
          file,
          upload_id,
        }
      })
      .catch((error: any) => {
        throw error
      })
  }

  /**
   * Retrieves upload metadata previously saved in `${file_id}.info`.
   * There's a small and simple caching mechanism to avoid multiple
   * HTTP calls to S3.
   *
   * @param  {String} file_id id of the file
   * @return {Promise<Object>}        which resolves with the metadata
   */
  _getMetadata(file_id: any) {
    log(`[${file_id}] retrieving metadata`)
    if (this.cache[file_id] && this.cache[file_id].file) {
      log(`[${file_id}] metadata from cache`)
      return Promise.resolve(this.cache[file_id])
    }

    log(`[${file_id}] metadata from s3`)
    return this.client
      .headObject({
        Bucket: this.bucket_name,
        Key: `${file_id}.info`,
      })
      .promise()
      .then((data: any) => {
        this.cache[file_id] = {
          ...data.Metadata,
          file: JSON.parse(data.Metadata.file),
          // Patch for Digital Ocean: if key upload_id (AWS, standard) doesn't exist in Metadata object, fallback to upload-id (DO)
          upload_id: data.Metadata.upload_id || data.Metadata['upload-id'],
        }
        return this.cache[file_id]
      })
      .catch((error: any) => {
        throw error
      })
  }

  /**
   * Parses the Base64 encoded metadata received from the client.
   *
   * @param  {String} metadata_string tus' standard upload metadata
   * @return {Object}                 metadata as key-value pair
   */
  _parseMetadataString(metadata_string: any) {
    if (!metadata_string) {
      return {}
    }

    const kv_pair_list = metadata_string.split(',')
    return kv_pair_list.reduce((metadata: any, kv_pair: any) => {
      const [key, base64_value] = kv_pair.split(' ')
      metadata[key] = {
        encoded: base64_value,
        decoded:
          base64_value === undefined
            ? undefined
            : Buffer.from(base64_value, 'base64').toString('ascii'),
      }
      return metadata
    }, {})
  }

  /**
   * Uploads a part/chunk to S3 from a temporary part file.
   *
   * @param  {Object}          metadata            upload metadata
   * @param  {Stream}          read_stream         incoming request read stream
   * @param  {Number}          current_part_number number of the current part/chunk
   * @return {Promise<String>}                     which resolves with the parts' etag
   */
  _uploadPart(metadata: any, read_stream: any, current_part_number: any) {
    return this.client
      .uploadPart({
        Bucket: this.bucket_name,
        Key: metadata.file.id,
        UploadId: metadata.upload_id,
        PartNumber: current_part_number,
        Body: read_stream,
      })
      .promise()
      .then((data: any) => {
        log(`[${metadata.file.id}] finished uploading part #${current_part_number}`)
        return data.ETag
      })
  }

  /**
   * Uploads a stream to s3 using multiple parts
   *
   * @param {Object}         metadata upload metadata
   * @param {fs<ReadStream>} readStream incoming request
   * @param {Number}         currentPartNumber number of the current part/chunk
   * @param {Number}         current_size current size of uploaded data
   * @return {Promise<Number>} which resolves with the current offset
   * @memberof S3Store
   */
  _processUpload(
    metadata: any,
    readStream: any,
    currentPartNumber: any,
    current_size: any
  ) {
    return new Promise((resolve, reject) => {
      // @ts-expect-error TS(2554): Expected 2 arguments, but got 1.
      const splitterStream = new FileStreamSplitter({
        maxChunkSize: this.part_size,
        directory: os.tmpdir(),
      })
      const promises: any = []
      let pendingChunkFilepath: any = null
      stream.pipeline(readStream, splitterStream, (pipelineErr: any) => {
        if (pipelineErr && pendingChunkFilepath !== null) {
          fs.rm(pendingChunkFilepath, (fileRemoveErr: any) => {
            if (fileRemoveErr) {
              log(`[${metadata.file.id}] failed to remove chunk ${pendingChunkFilepath}`)
            }
          })
        }

        promises.push(pipelineErr ? Promise.reject(pipelineErr) : Promise.resolve())
        resolve(promises)
      })
      splitterStream.on('chunkStarted', (filepath: any) => {
        pendingChunkFilepath = filepath
      })
      splitterStream.on('chunkFinished', ({path, size}: any) => {
        pendingChunkFilepath = null
        current_size += size
        const partNumber = currentPartNumber++
        const p = Promise.resolve()
          .then(() => {
            // Skip chunk if it is not last and is smaller than 5MB
            const is_last_chunk =
              Number.parseInt(metadata.file.upload_length, 10) === current_size
            if (!is_last_chunk && size < 5 * 1024 * 1024) {
              log(`[${metadata.file.id}] ignoring chuck smaller than 5MB`)
              return
            }

            return this._uploadPart(metadata, fs.createReadStream(path), partNumber)
          })
          .finally(() => {
            fs.rm(path, (err: any) => {
              if (err) {
                log(`[${metadata.file.id}] failed to remove file ${path}`, err)
              }
            })
          })
        promises.push(p)
      })
    })
  }

  /**
   * Completes a multipart upload on S3.
   * This is where S3 concatenates all the uploaded parts.
   *
   * @param  {Object}          metadata upload metadata
   * @param  {Array}           parts    data of each part
   * @return {Promise<String>}          which resolves with the file location on S3
   */
  _finishMultipartUpload(metadata: any, parts: any) {
    return this.client
      .completeMultipartUpload({
        Bucket: this.bucket_name,
        Key: metadata.file.id,
        UploadId: metadata.upload_id,
        MultipartUpload: {
          Parts: parts.map((part: any) => {
            return {
              ETag: part.ETag,
              PartNumber: part.PartNumber,
            }
          }),
        },
      })
      .promise()
      .then((result: any) => result.Location)
      .catch((error: any) => {
        throw error
      })
  }

  /**
   * Gets the number of complete parts/chunks already uploaded to S3.
   * Retrieves only consecutive parts.
   *
   * @param  {String}          file_id            id of the file
   * @param  {String}          part_number_marker optional part number marker
   * @return {Promise<Array>}                    upload parts
   */
  _retrieveParts(file_id: any, part_number_marker: any) {
    const params = {
      Bucket: this.bucket_name,
      Key: file_id,
      UploadId: this.cache[file_id].upload_id,
    }
    if (part_number_marker) {
      ;(params as any).PartNumberMarker = part_number_marker
    }

    return this.client
      .listParts(params)
      .promise()
      .then((data: any) => {
        if (data.NextPartNumberMarker) {
          return this._retrieveParts(file_id, data.NextPartNumberMarker).then(
            (val: any) => [].concat(data.Parts, val)
          )
        }

        return data.Parts
      })
      .then((parts: any) => {
        // Sort and filter only for call where `part_number_marker` is not set
        if (part_number_marker === undefined) {
          parts.sort((a: any, b: any) => {
            return a.PartNumber - b.PartNumber
          })
          parts = parts.filter((value: any, index: any) => {
            return value.PartNumber === index + 1
          })
        }

        return parts
      })
  }

  /**
   * Gets the number of parts/chunks
   * already uploaded to S3.
   *
   * @param  {String}          file_id            id of the file
   * @return {Promise<Number>}                    number of parts
   */
  async _countParts(file_id: any) {
    // @ts-expect-error TS(2554): Expected 2 arguments, but got 1.
    return await this._retrieveParts(file_id).then((parts: any) => parts.length)
  }

  /**
   * Removes cached data for a given file.
   * @param  {String} file_id id of the file
   * @return {undefined}
   */
  _clearCache(file_id: any) {
    log(`[${file_id}] removing cached data`)
    delete this.cache[file_id]
  }

  create(file: any) {
    return this._bucketExists()
      .then(() => {
        return this._initMultipartUpload(file)
      })
      .then(() => file)
      .catch((error: any) => {
        this._clearCache(file.id)
        throw error
      })
  }

  /**
   * Write to the file, starting at the provided offset
   *
   * @param {object} readable stream.Readable
   * @param {string} file_id Name of file
   * @param {integer} offset starting offset
   * @return {Promise}
   */
  write(readable: any, file_id: any) {
    return this._getMetadata(file_id)
      .then((metadata: any) => {
        return Promise.all([metadata, this._countParts(file_id), this.getOffset(file_id)])
      })
      .then(async (results: any) => {
        const [metadata, part_number, initial_offset] = results
        const next_part_number = part_number + 1
        return Promise.all(
          // @ts-expect-error TS(2769): No overload matches this call.
          await this._processUpload(
            metadata,
            readable,
            next_part_number,
            initial_offset.size
          )
        )
          .then(() => this.getOffset(file_id))
          .then((current_offset) => {
            if (
              Number.parseInt(metadata.file.upload_length, 10) === current_offset.size
            ) {
              return this._finishMultipartUpload(metadata, current_offset.parts)
                .then(() => {
                  this._clearCache(file_id)
                  return current_offset.size
                })
                .catch((error: any) => {
                  log(`[${file_id}] failed to finish upload`, error)
                  throw error
                })
            }

            return current_offset.size
          })
          .catch((error) => {
            if (['RequestTimeout', 'NoSuchUpload'].includes(error.code)) {
              if (error.code === 'RequestTimeout') {
                log(
                  'Request "close" event was emitted, however S3 was expecting more data. Failing gracefully.'
                )
              }

              if (error.code === 'NoSuchUpload') {
                log(
                  'Request "close" event was emitted, however S3 was expecting more data. Most likely the upload is already finished/aborted. Failing gracefully.'
                )
              }

              return this.getOffset(file_id).then((current_offset) => current_offset.size)
            }

            this._clearCache(file_id)
            log(`[${file_id}] failed to write file`, error)
            throw error
          })
      })
  }

  async getOffset(id: any) {
    let metadata
    try {
      metadata = await this._getMetadata(id)
    } catch (error) {
      log('getOffset: No file found.', error)
      throw ERRORS.FILE_NOT_FOUND
    }

    try {
      // @ts-expect-error TS(2554): Expected 2 arguments, but got 1.
      const parts = await this._retrieveParts(id)
      return {
        ...this.cache[id].file,
        size: parts.length > 0 ? parts.reduce((a: any, b: any) => a + b.Size, 0) : 0,
        upload_length: metadata.file.upload_length,
        upload_defer_length: metadata.file.upload_defer_length,
        parts,
      }
    } catch (error) {
      if ((error as any).code !== 'NoSuchUpload') {
        log(error)
        throw error
      }

      // When the last part of an upload is finished and the file is successfully written to S3,
      // the upload will no longer be present and requesting it will result in a 404.
      // In that case we return the upload_length as size.
      return {
        ...this.cache[id].file,
        size: metadata.file.upload_length,
        upload_length: metadata.file.upload_length,
        upload_defer_length: metadata.file.upload_defer_length,
      }
    }
  }

  async declareUploadLength(file_id: any, upload_length: any) {
    const {file, upload_id} = await this._getMetadata(file_id)
    if (!file) {
      throw ERRORS.FILE_NOT_FOUND
    }

    file.upload_length = upload_length
    file.upload_defer_length = undefined
    this._saveMetadata(file, upload_id)
  }
}
export default S3Store