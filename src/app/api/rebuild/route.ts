import { NextRequest, NextResponse } from 'next/server';
import { URL } from 'url';

import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

function pickNumberFromStr(str: string): number {
  const match = str.match(/\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

//几种常见的ts文件列表规律。每一个ts文件名与第一行作比较，
// 若存在某一行不符合任何一条规律，则认为它是一条广告切片。
// 规律函数有顺序，越靠前的误判率越低，越靠后的误判率越高。
const white_rules = [
  function (first_ts: string, lastLine: string, line: string) {
    return pickNumberFromStr(first_ts) >= 0
      && pickNumberFromStr(line) - pickNumberFromStr(lastLine) >= 1
      && pickNumberFromStr(line) - pickNumberFromStr(lastLine) <= 5 // 允许跳过1-5个切片
  },
  //*：每行只有一个文件名且文件名为纯数字（或者除首位字符外为纯数字）。
  function (first_ts: string, lastLine: string, line: string) {
    return line.lastIndexOf('/') <= 0 && !isNaN(Number(line.substring(1, line.lastIndexOf('.'))));
  },
  //*：判断整行内容，除了uri最后一段（用/分隔的最后一段）之外前面的均重合：
  function (first_ts: string, lastLine: string, line: string) {
    const first_file_index = first_ts.lastIndexOf('/')
    const line_index = line.lastIndexOf('/')
    return first_file_index == line_index && line.startsWith(first_ts.substring(0, first_file_index));
  },
  //*： 文件名以相同的5位字符开头，且文件名字符长度相同，末位部分不同。
  function (first_ts: string, lastLine: string, line: string) {
    const first_file = first_ts.substring(first_ts.lastIndexOf('/') + 1)
    const file = line.substring(line.lastIndexOf('/') + 1)
    return file.startsWith(first_file.substring(0, 5)) && file.length == first_ts.length
  },
  //*：判断整行内容前10个字符重合,不要求全名的字符长度相同。
  function (first_ts: string, lastLine: string, line: string) {
    return line.indexOf("/", 1) >= 1 && line.startsWith(first_ts.substring(0, 10));
  },
]

const black_rules = [
  //第一种：路径以 /video/adjump/time/ 或 /video/adjump/ 或 /video/adtime/ 开头的，认为是广告切片。
  function (first_ts: string, lastLine: string, line: string) {
    return line.startsWith("/video/adjump/time/") || line.startsWith("/video/adjump/") || line.startsWith("/video/adtime/");
  }
]
const ad_check_count = [0, 0, 0, 0, 0]

//通常广告切片不出现在前十个ts文件中。
//因此首先用前十个文件验证哪些规律函数是有效的，
// 通过对累计通过数大于5，将有效函数放到内置数组 use_func
// 此后对每行ts内容只使用use_func中的函数进行验证。
// 目前只要有一项规律函数通过检测，就不再使用其他规律进行验证。
function testAdMatch(firstTs: string, lastLine: string, line: string) {
  const threshold = 5
  const use_func: number[] = []
  for (let i = 0; i < white_rules.length; i++) {
    if (white_rules[i](firstTs, lastLine, line)) {
      ad_check_count[i]++;
    }
  }
  if (use_func.length == 0) {
    for (let i = 0; i < white_rules.length; i++) {
      if (white_rules[i](firstTs, lastLine, line)) {
        ad_check_count[i]++;

        if (ad_check_count[i] >= threshold) {
          use_func.push(i)
        }
      }
    }
    return true
  } else {

    for (const i in black_rules) {
      if (black_rules[i](firstTs, lastLine, line)) {
        return false
      }
    }

    let pass = false
    for (let i = 0; i < use_func.length; i++) {
      if (white_rules[use_func[i]](firstTs, lastLine, line)) {
        ad_check_count[use_func[i]]++;
        pass = true
      }
    }
    return pass
  }
}


/**
 * 将m3u8内容处理：
 * 1. .ts/.key等资源 → 转为源站绝对地址
 * 2. #EXT-X-STREAM-INF 后的子m3u8清晰度地址 → 代理为当前 /api/rebuild 接口
 * @param m3u8Content 原始文本
 * @param baseUrl 原始m3u8完整源地址
 * @param selfApiOrigin 当前服务域名+根路径，用于拼接代理接口
 */
function resolveM3u8RelativePaths(
  m3u8Content: string,
  baseUrl: string,
  selfProxyApi: string
): string[] {
  const baseUri = new URL(baseUrl);
  const baseDir = new URL('.', baseUri.href).href;

  const lines = m3u8Content.split(/\r?\n/);
  const output: string[] = [];

  let nextLineIsStreamTarget = false;

  let firstTs: string | null = null;
  let lastLine: string | null = null;
  let ad_pos = 0

  for (const line of lines) {
    const trimLine = line.trim();

    if (trimLine.startsWith('#EXT-X-STREAM-INF:')) {
      output.push(line);
      nextLineIsStreamTarget = true;
      continue;
    }

    // ========== 子清晰度m3u8 包装成本接口代理地址 ==========
    if (nextLineIsStreamTarget && trimLine && !trimLine.startsWith('#')) {
      const proxyUrlObj = new URL(selfProxyApi);
      if (line.startsWith('http://') || line.startsWith('https://')) {
        proxyUrlObj.searchParams.set("url", line);
        output.push(proxyUrlObj.toString());
      } else {
        try {
          // 1.先算出子m3u8原始绝对地址
          const childM3u8OriginUrl = new URL(trimLine, baseDir).href;
          // 2. url编码源地址，拼接到自身rebuild接口
          proxyUrlObj.searchParams.set("url", childM3u8OriginUrl);
          output.push(proxyUrlObj.toString());
        } catch {
          console.warn('子清晰度m3u8地址解析失败，直接输出原始内容：', line,
            "baseUrl:", baseUrl
          );
          output.push(line);
        }
      }
      nextLineIsStreamTarget = false;
      continue;
    }

    nextLineIsStreamTarget = false;

    if (!trimLine) {
      output.push(line);
      continue;
    }

    // 注释行直接保留
    if (trimLine.startsWith('#')) {
      if (trimLine === '#EXT-X-DISCONTINUITY') {
        if (firstTs) {
          if (ad_pos > 0) {
            //如果广告切片片数达到20，则可能是误判。通常广告只有9-15个切片，时间长度不超过45秒
            if (output.length - ad_pos < 20) {
              // 删除广告切片
              output.splice(ad_pos, output.length - ad_pos);
            }
            ad_pos = 0
          } else {
            ad_pos = output.length
          }
        }
      } else {
        output.push(line);
      }
      continue;
    }

    //ad_pos大于0时说明处于#EXT-X-DISCONTINUITY标签对之中，属于即将被剪去的片段，不再进行其他过滤。
    //
    if (ad_pos == 0) {
      if (firstTs && !testAdMatch(firstTs, lastLine!, trimLine)) {
        console.log("广告切片过滤：", trimLine, "规则统计：", ad_check_count)
        continue;
      }
    }

    if (!firstTs) {
      firstTs = trimLine;
    }
    lastLine = trimLine;

    // ts、key、加密资源：正常转为源站绝对链接（不代理）
    try {
      const absolute = new URL(trimLine, baseDir).href;
      output.push(absolute);
    } catch {
      output.push(line);
    }
  }

  return output;
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }
  // 简单协议校验
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return NextResponse.json({ error: 'Invalid source url protocol', status: 400 });
  }

  try {
    const originRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!originRes.ok) {
      return NextResponse.json(
        { error: `Source m3u8 request failed, status:${originRes.status}` },
        { status: originRes.status }
      );
    }

    let m3u8Text = await originRes.text();

    // 拼接当前自身代理接口完整地址
    // request.nextUrl.origin = http://localhost:3000
    // 你配置了 basePath: "/lunatv"
    const selfProxyApi = `${request.nextUrl.origin}/lunatv/api/rebuild`;

    // 执行转换逻辑
    m3u8Text = resolveM3u8RelativePaths(m3u8Text, targetUrl, selfProxyApi).join('\n');

    // 复制上游响应头
    const responseHeaders = new Headers();
    const copyHeaderList = [
      'content-type',
      'cache-control',
      'expires',
      'date',
      'etag',
      'last-modified',
      'vary',
    ];

    for (const hName of copyHeaderList) {
      const val = originRes.headers.get(hName);
      if (val) responseHeaders.set(hName, val);
    }
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');

    return new NextResponse(m3u8Text, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('rebuild m3u8 error:', err);
    return NextResponse.json({ error: 'Request m3u8 source failed' }, { status: 500 });
  }
}
