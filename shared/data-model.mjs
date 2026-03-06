const PROVINCE_ALIASES = Object.freeze({
    '北京市': '北京',
    '天津市': '天津',
    '上海市': '上海',
    '重庆市': '重庆',
    '内蒙古自治区': '内蒙古',
    '广西壮族自治区': '广西',
    '西藏自治区': '西藏',
    '宁夏回族自治区': '宁夏',
    '新疆维吾尔自治区': '新疆',
    '香港特别行政区': '香港',
    '澳门特别行政区': '澳门'
});

const REQUIRED_FIELDS = ['name', 'school', 'city', 'province'];

export const DATA_KEYS = Object.freeze({
    raw: 'students:raw:v1',
    public: 'students:public:v1'
});

export const DATA_VERSION = 'v1';

function normalizeText(value, fieldName, contextLabel) {
    if (typeof value !== 'string') {
        throw new TypeError(`${contextLabel} field \"${fieldName}\" must be a string.`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized) {
        throw new Error(`${contextLabel} field \"${fieldName}\" cannot be empty.`);
    }

    return normalized;
}

export function normalizeProvince(value, contextLabel = 'province') {
    const normalized = normalizeText(value, 'province', contextLabel);
    return PROVINCE_ALIASES[normalized] || normalized;
}

export function normalizeStudent(record, index = 0) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new TypeError(`Student #${index + 1} must be an object.`);
    }

    for (const fieldName of REQUIRED_FIELDS) {
        if (!(fieldName in record)) {
            throw new Error(`Student #${index + 1} is missing required field \"${fieldName}\".`);
        }
    }

    return {
        name: normalizeText(record.name, 'name', `Student #${index + 1}`),
        school: normalizeText(record.school, 'school', `Student #${index + 1}`),
        city: normalizeText(record.city, 'city', `Student #${index + 1}`),
        province: normalizeProvince(record.province, `Student #${index + 1}`)
    };
}

export function normalizeStudents(records) {
    if (!Array.isArray(records)) {
        throw new TypeError('Students data must be an array.');
    }

    return records.map((record, index) => normalizeStudent(record, index));
}

export function buildPublicDataset(students) {
    const provinces = {};
    const provinceSet = new Set();
    const citySet = new Set();

    for (const student of students) {
        provinceSet.add(student.province);
        citySet.add(`${student.province}::${student.city}`);

        if (!provinces[student.province]) {
            provinces[student.province] = {
                count: 0,
                cities: {}
            };
        }

        provinces[student.province].count += 1;
        provinces[student.province].cities[student.city] = (provinces[student.province].cities[student.city] || 0) + 1;
    }

    return {
        version: DATA_VERSION,
        generatedAt: new Date().toISOString(),
        stats: {
            total: students.length,
            provinces: provinceSet.size,
            cities: citySet.size
        },
        provinces
    };
}

export function filterStudentsByRegion(students, region) {
    const province = normalizeProvince(region.province, 'query');
    const city = region.city ? normalizeText(region.city, 'city', 'query') : null;

    return students.filter((student) => {
        if (student.province !== province) {
            return false;
        }

        if (city && student.city !== city) {
            return false;
        }

        return true;
    });
}

export function sortPeople(people) {
    return [...people].sort((left, right) => {
        const cityDiff = left.city.localeCompare(right.city, 'zh-CN');
        if (cityDiff !== 0) {
            return cityDiff;
        }

        const schoolDiff = left.school.localeCompare(right.school, 'zh-CN');
        if (schoolDiff !== 0) {
            return schoolDiff;
        }

        return left.name.localeCompare(right.name, 'zh-CN');
    });
}
