# -*- coding: utf-8 -*-
"""Build a readable markdown study file from the SAA-C03 exam PDF text
and the personally-solved answer notes."""
import re
import io

PDF_TXT = "pdf_extracted.txt"
SOL_TXT = "AWS SAA-03 Solution.txt"
OUT_MD = "AWS-SAA-C03-Questions.md"


def read_text(path):
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            with io.open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    raise RuntimeError("cannot decode " + path)


def norm(s):
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def parse_questions(text):
    text = text.replace("\x0c", "\n")
    text = re.sub(r"^Topic \d+ - Exam [A-Z]\s*$", "", text, flags=re.M)
    parts = re.split(r"^Question #(\d+)\s+Topic \d+\s*$", text, flags=re.M)
    questions = {}
    for i in range(1, len(parts) - 1, 2):
        num = int(parts[i])
        body = parts[i + 1]
        lines = body.split("\n")
        q_lines = []
        options = []  # list of [letter, text]
        cur = None
        for ln in lines:
            m = re.match(r"^\s*([A-F])\.\s+(.*)$", ln)
            if m:
                cur = [m.group(1), m.group(2).strip()]
                options.append(cur)
            elif cur is not None:
                s = ln.strip()
                if s:
                    cur[1] += " " + s
            else:
                q_lines.append(ln.strip())
        qtext_raw = "\n".join(q_lines)
        paras = [re.sub(r"\s+", " ", p).strip()
                 for p in re.split(r"\n\s*\n", qtext_raw)]
        paras = [p for p in paras if p]
        qtext = "\n\n".join(paras)
        questions[num] = {"text": qtext, "options": options}
    return questions


def parse_solutions(text):
    text = text.replace("\r\n", "\n")
    entries = {}
    parts = re.split(r"^(\d+)\]", text, flags=re.M)
    for i in range(1, len(parts) - 1, 2):
        num = int(parts[i])
        body = re.split(r"^-{10,}\s*$", parts[i + 1], flags=re.M)[0]
        entries[num] = body.strip("\n")
    return entries


def strip_restated_question(body, qtext):
    """Drop leading lines that merely restate the question stem."""
    qnorm = norm(qtext)
    lines = body.split("\n")
    idx = 0
    for i, ln in enumerate(lines):
        s = ln.strip()
        if not s:
            if idx == i:  # leading blank
                idx = i + 1
            continue
        n = norm(s)
        if n and n in qnorm:
            idx = i + 1
        else:
            break
    return "\n".join(lines[idx:]).strip("\n")


def match_option_letter(ans_text, options):
    a = norm(ans_text)
    if not a:
        return None
    for letter, opt in options:
        o = norm(opt)
        if not o:
            continue
        k = min(len(a), len(o), 60)
        if k >= 20 and a[:k] == o[:k]:
            return letter
    return None


def extract_answer(rest, options):
    """Return (answer_lines, explanation) from the de-duplicated entry body."""
    lines = rest.split("\n")
    # skip leading blanks
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines):
        return [], ""

    first = lines[i].strip()

    # style 1: "ans- <text>"
    m = re.match(r"^ans\s*-\s*(.*)$", first, flags=re.I)
    if m:
        ans = m.group(1).strip()
        j = i + 1
        while j < len(lines) and lines[j].strip():
            ans += " " + lines[j].strip()
            j += 1
        letter = match_option_letter(ans, options)
        label = ("%s. %s" % (letter, ans)) if letter else ans
        return [label], "\n".join(lines[j:]).strip("\n")

    # style 2: leading option-letter lines ("A. xxx" / "B xxx")
    answers = []
    j = i
    while j < len(lines):
        s = lines[j].strip()
        m = re.match(r"^([A-F])[.)]?\s+(\S.*)$", s)
        if m and (m.group(1) + m.group(2))[:1].isupper():
            txt = m.group(2).strip()
            # absorb wrapped continuation lines
            k = j + 1
            while k < len(lines) and lines[k].strip() and \
                    not re.match(r"^([A-F])[.)]?\s+\S", lines[k].strip()):
                txt += " " + lines[k].strip()
                k += 1
            answers.append("%s. %s" % (m.group(1), txt))
            j = k
        else:
            break
    if answers:
        return answers, "\n".join(lines[j:]).strip("\n")

    # style 3: "Answer:" / "Answers:" / "Correct answer" paragraph
    m = re.match(r"^(Answers?\s*[:\-]|Correct answers?\s*[:\-]?)\s*(.*)$",
                 first, flags=re.I)
    if m:
        ans = m.group(2).strip()
        j = i + 1
        while j < len(lines) and lines[j].strip():
            ans += " " + lines[j].strip()
            j += 1
        return [ans] if ans else [], "\n".join(lines[j:]).strip("\n")

    # no recognizable answer header: if the first paragraph is verbatim
    # option text, promote it to the answer
    j = i
    para = []
    while j < len(lines) and lines[j].strip():
        para.append(lines[j].strip())
        j += 1
    para_text = " ".join(para)
    letter = match_option_letter(para_text, options)
    if letter:
        return ["%s. %s" % (letter, para_text)], "\n".join(lines[j:]).strip("\n")
    return [], rest


def fmt_paragraphs(text):
    """Merge hard-wrapped prose, keep bullets/numbered lines."""
    out = []
    for p in re.split(r"\n\s*\n", text):
        p = p.strip("\n")
        if not p.strip():
            continue
        buf = []
        for l in p.split("\n"):
            s = l.strip()
            if not s:
                continue
            if re.match(r"^[-*•>]", s) or re.match(r"^\d+[.)]\s", s) \
                    or re.match(r"^[A-F][.)]\s", s):
                buf.append(("- " + s.lstrip("-*• ").strip())
                           if re.match(r"^[-*•]", s) else s)
            elif buf and not re.match(r"^(- |\d+[.)]|[A-F][.)])", buf[-1][:3]):
                buf[-1] += " " + s
            elif buf:
                buf.append(s)
            else:
                buf.append(s)
        out.append("\n".join(buf))
    return "\n\n".join(out)


def main():
    questions = parse_questions(read_text(PDF_TXT))
    solutions = parse_solutions(read_text(SOL_TXT))

    nums = sorted(questions)
    total = len(nums)
    answered = sum(1 for n in nums if n in solutions)

    md = []
    md.append("# AWS Certified Solutions Architect – Associate (SAA-C03) 题库\n")
    md.append("> 题目来源:`AWS Certified Solutions Architect Associate SAA-C03.pdf`"
              ",答案与解析来自 `AWS SAA-03 Solution.txt`。\n>\n"
              "> 共 **%d** 题,其中 **%d** 题附有答案与解析。"
              "点击每题下方的 **Answer & Explanation** 可展开答案(便于自测)。\n"
              % (total, answered))

    md.append("\n## 目录\n")
    sec_size = 50
    sections = []
    for start in range(1, nums[-1] + 1, sec_size):
        end = min(start + sec_size - 1, nums[-1])
        in_range = [n for n in nums if start <= n <= end]
        if not in_range:
            continue
        sections.append((start, end, in_range))
        md.append("- [Questions %d – %d](#questions-%d--%d)"
                  % (start, end, start, end))
    md.append("")

    stats = {"with_letter": 0, "plain": 0, "none": 0}
    for start, end, in_range in sections:
        md.append("\n---\n")
        md.append("## Questions %d – %d\n" % (start, end))
        for n in in_range:
            q = questions[n]
            md.append("### Question %d\n" % n)
            if q["text"]:
                md.append(q["text"] + "\n")
            for letter, opt in q["options"]:
                md.append("- **%s.** %s" % (letter, opt))
            md.append("")
            sol = solutions.get(n)
            if sol is None:
                md.append("*（暂无答案解析）*\n")
                stats["none"] += 1
                continue
            rest = strip_restated_question(sol, q["text"])
            answers, expl = extract_answer(rest, q["options"])
            md.append("<details><summary><b>Answer &amp; Explanation</b></summary>\n")
            if answers:
                if any(re.match(r"^[A-F]\.\s", a) for a in answers):
                    stats["with_letter"] += 1
                else:
                    stats["plain"] += 1
                md.append("**Answer:**\n")
                for a in answers:
                    md.append("- **%s**" % a)
                md.append("")
            else:
                stats["plain"] += 1
            expl_fmt = fmt_paragraphs(expl)
            if expl_fmt:
                md.append(expl_fmt)
            md.append("\n</details>\n")

    with io.open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print("questions:", total, "answered:", answered, "stats:", stats,
          "->", OUT_MD)


if __name__ == "__main__":
    main()
